/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import apm from 'elastic-apm-node';
import { omit, some } from 'lodash';
import { UsageCounter } from '@kbn/usage-collection-plugin/server';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@kbn/core/server';
import {
  ConcreteTaskInstance,
  throwUnrecoverableError,
  createTaskRunError,
  TaskErrorSource,
} from '@kbn/task-manager-plugin/server';
import { nanosToMillis } from '@kbn/event-log-plugin/server';
import { DEFAULT_NAMESPACE_STRING } from '@kbn/core-saved-objects-utils-server';
import { ExecutionHandler, RunResult } from './execution_handler';
import { TaskRunnerContext } from './task_runner_factory';
import {
  ElasticsearchError,
  ErrorWithReason,
  executionStatusFromError,
  executionStatusFromState,
  ruleExecutionStatusToRaw,
  isRuleSnoozed,
  lastRunFromError,
  getNextRun,
} from '../lib';
import {
  RuleExecutionStatus,
  RuleExecutionStatusErrorReasons,
  IntervalSchedule,
  RawRuleExecutionStatus,
  RawRuleMonitoring,
  RuleTaskState,
  RuleTypeRegistry,
  RawRuleLastRun,
} from '../types';
import { asErr, asOk, isErr, isOk, map, resolveErr, Result } from '../lib/result_type';
import { taskInstanceToAlertTaskInstance } from './alert_task_instance';
import { isAlertSavedObjectNotFoundError, isEsUnavailableError } from '../lib/is_alerting_error';
import { partiallyUpdateAlert } from '../saved_objects';
import {
  AlertInstanceContext,
  AlertInstanceState,
  RuleTypeParams,
  RuleTypeState,
  parseDuration,
  RawAlertInstance,
  RuleLastRunOutcomeOrderMap,
  RuleAlertData,
  SanitizedRule,
  RuleNotifyWhen,
} from '../../common';
import { NormalizedRuleType, UntypedNormalizedRuleType } from '../rule_type_registry';
import { getEsErrorMessage } from '../lib/errors';
import { InMemoryMetrics, IN_MEMORY_METRICS } from '../monitoring';
import {
  RuleTaskInstance,
  RuleTaskRunResult,
  RuleTaskStateAndMetrics,
  RunRuleParams,
} from './types';
import { createWrappedScopedClusterClientFactory } from '../lib/wrap_scoped_cluster_client';
import { IExecutionStatusAndMetrics } from '../lib/rule_execution_status';
import { RuleRunMetricsStore } from '../lib/rule_run_metrics_store';
import { wrapSearchSourceClient } from '../lib/wrap_search_source_client';
import { AlertingEventLogger } from '../lib/alerting_event_logger/alerting_event_logger';
import {
  getRuleAttributes,
  RuleData,
  RuleDataResult,
  ValidatedRuleData,
  validateRule,
} from './rule_loader';
import { TaskRunnerTimer, TaskRunnerTimerSpan } from './task_runner_timer';
import { RuleMonitoringService } from '../monitoring/rule_monitoring_service';
import { ILastRun, lastRunFromState, lastRunToRaw } from '../lib/last_run_status';
import { RunningHandler } from './running_handler';
import { RuleResultService } from '../monitoring/rule_result_service';
import { LegacyAlertsClient } from '../alerts_client';
import { IAlertsClient } from '../alerts_client/types';
import { MaintenanceWindow } from '../application/maintenance_window/types';
import { getTimeRange } from '../lib/get_time_range';

const FALLBACK_RETRY_INTERVAL = '5m';
const CONNECTIVITY_RETRY_INTERVAL = '5m';

interface StackTraceLog {
  message: ElasticsearchError;
  stackTrace?: string;
}

interface TaskRunnerConstructorParams<
  Params extends RuleTypeParams,
  ExtractedParams extends RuleTypeParams,
  RuleState extends RuleTypeState,
  AlertState extends AlertInstanceState,
  Context extends AlertInstanceContext,
  ActionGroupIds extends string,
  RecoveryActionGroupId extends string,
  AlertData extends RuleAlertData
> {
  ruleType: NormalizedRuleType<
    Params,
    ExtractedParams,
    RuleState,
    AlertState,
    Context,
    ActionGroupIds,
    RecoveryActionGroupId,
    AlertData
  >;
  taskInstance: ConcreteTaskInstance;
  context: TaskRunnerContext;
  inMemoryMetrics: InMemoryMetrics;
}

export class TaskRunner<
  Params extends RuleTypeParams,
  ExtractedParams extends RuleTypeParams,
  RuleState extends RuleTypeState,
  AlertState extends AlertInstanceState,
  Context extends AlertInstanceContext,
  ActionGroupIds extends string,
  RecoveryActionGroupId extends string,
  AlertData extends RuleAlertData
> {
  private context: TaskRunnerContext;
  private logger: Logger;
  private taskInstance: RuleTaskInstance;
  private ruleConsumer: string | null;
  private ruleType: NormalizedRuleType<
    Params,
    ExtractedParams,
    RuleState,
    AlertState,
    Context,
    ActionGroupIds,
    RecoveryActionGroupId,
    AlertData
  >;
  private readonly executionId: string;
  private readonly ruleTypeRegistry: RuleTypeRegistry;
  private readonly inMemoryMetrics: InMemoryMetrics;
  private readonly maxAlerts: number;
  private timer: TaskRunnerTimer;
  private alertingEventLogger: AlertingEventLogger;
  private usageCounter?: UsageCounter;
  private searchAbortController: AbortController;
  private cancelled: boolean;
  private stackTraceLog: StackTraceLog | null;
  private ruleMonitoring: RuleMonitoringService;
  private ruleRunning: RunningHandler;
  private ruleResult: RuleResultService;
  private ruleData?: RuleDataResult<RuleData<Params>>;
  private runDate = new Date();

  constructor({
    ruleType,
    taskInstance,
    context,
    inMemoryMetrics,
  }: TaskRunnerConstructorParams<
    Params,
    ExtractedParams,
    RuleState,
    AlertState,
    Context,
    ActionGroupIds,
    RecoveryActionGroupId,
    AlertData
  >) {
    this.context = context;
    const loggerId = ruleType.id.startsWith('.') ? ruleType.id.substring(1) : ruleType.id;
    this.logger = context.logger.get(loggerId);
    this.usageCounter = context.usageCounter;
    this.ruleType = ruleType;
    this.ruleConsumer = null;
    this.taskInstance = taskInstanceToAlertTaskInstance(taskInstance);
    this.ruleTypeRegistry = context.ruleTypeRegistry;
    this.searchAbortController = new AbortController();
    this.cancelled = false;
    this.executionId = uuidv4();
    this.inMemoryMetrics = inMemoryMetrics;
    this.maxAlerts = context.maxAlerts;
    this.timer = new TaskRunnerTimer({ logger: this.logger });
    this.alertingEventLogger = new AlertingEventLogger(this.context.eventLogger);
    this.stackTraceLog = null;
    this.ruleMonitoring = new RuleMonitoringService();
    this.ruleRunning = new RunningHandler(
      this.context.internalSavedObjectsRepository,
      this.logger,
      loggerId
    );
    this.ruleResult = new RuleResultService();
  }

  private async updateRuleSavedObjectPostRun(
    ruleId: string,
    namespace: string | undefined,
    attributes: {
      executionStatus?: RawRuleExecutionStatus;
      monitoring?: RawRuleMonitoring;
      nextRun?: string | null;
      lastRun?: RawRuleLastRun | null;
    }
  ) {
    const client = this.context.internalSavedObjectsRepository;
    try {
      // Future engineer -> Here we are just checking if we need to wait for
      // the update of the attribute `running` in the rule's saved object
      // and we are swallowing the error because we still want to move forward
      // with the update of our rule since we are putting back the running attribute
      // back to false
      await this.ruleRunning.waitFor();
      // eslint-disable-next-line no-empty
    } catch {}
    try {
      await partiallyUpdateAlert(
        client,
        ruleId,
        { ...attributes, running: false },
        {
          ignore404: true,
          namespace,
          refresh: false,
        }
      );
    } catch (err) {
      this.logger.error(`error updating rule for ${this.ruleType.id}:${ruleId} ${err.message}`);
    }
  }

  private shouldLogAndScheduleActionsForAlerts() {
    // if execution hasn't been cancelled, return true
    if (!this.cancelled) {
      return true;
    }

    // if execution has been cancelled, return true if EITHER alerting config or rule type indicate to proceed with scheduling actions
    return !this.context.cancelAlertsOnRuleTimeout || !this.ruleType.cancelAlertsOnRuleTimeout;
  }

  private getAADRuleData(rule: SanitizedRule<Params>, spaceId: string) {
    return {
      consumer: rule.consumer,
      executionId: this.executionId,
      id: rule.id,
      name: rule.name,
      parameters: rule.params,
      revision: rule.revision,
      spaceId,
      tags: rule.tags,
    };
  }

  // Usage counter for telemetry
  // This keeps track of how many times action executions were skipped after rule
  // execution completed successfully after the execution timeout
  // This can occur when rule executors do not short circuit execution in response
  // to timeout
  private countUsageOfActionExecutionAfterRuleCancellation() {
    if (this.cancelled && this.usageCounter) {
      if (this.context.cancelAlertsOnRuleTimeout && this.ruleType.cancelAlertsOnRuleTimeout) {
        // Increment usage counter for skipped actions
        this.usageCounter.incrementCounter({
          counterName: `alertsSkippedDueToRuleExecutionTimeout_${this.ruleType.id}`,
          incrementBy: 1,
        });
      }
    }
  }

  private async runRule({
    fakeRequest,
    rule,
    apiKey,
    validatedParams: params,
  }: RunRuleParams<Params>): Promise<RuleTaskStateAndMetrics> {
    if (apm.currentTransaction) {
      apm.currentTransaction.name = `Execute Alerting Rule: "${rule.name}"`;
      apm.currentTransaction.addLabels({
        alerting_rule_consumer: rule.consumer,
        alerting_rule_name: rule.name,
        alerting_rule_tags: rule.tags.join(', '),
        alerting_rule_type_id: rule.alertTypeId,
        alerting_rule_params: JSON.stringify(rule.params),
      });
    }

    const {
      alertTypeId: ruleTypeId,
      consumer,
      schedule,
      throttle = null,
      notifyWhen = null,
      name,
      tags,
      createdBy,
      updatedBy,
      createdAt,
      updatedAt,
      enabled,
      actions,
      muteAll,
      revision,
      snoozeSchedule,
    } = rule;
    const {
      params: { alertId: ruleId, spaceId },
      state: {
        alertInstances: alertRawInstances = {},
        alertRecoveredInstances: alertRecoveredRawInstances = {},
        alertTypeState: ruleTypeState = {},
        previousStartedAt,
      },
    } = this.taskInstance;

    const ruleRunMetricsStore = new RuleRunMetricsStore();

    const namespace = this.context.spaceIdToNamespace(spaceId);
    const ruleType = this.ruleTypeRegistry.get(ruleTypeId);

    const ruleLabel = `${this.ruleType.id}:${ruleId}: '${name}'`;

    const rulesSettingsClient = this.context.getRulesSettingsClientWithRequest(fakeRequest);
    const flappingSettings = await rulesSettingsClient.flapping().get();
    const queryDelaySettings = await rulesSettingsClient.queryDelay().get();

    const alertsClientParams = {
      logger: this.logger,
      ruleType: this.ruleType as UntypedNormalizedRuleType,
    };

    // Create AlertsClient if rule type has registered an alerts context
    // with the framework. The AlertsClient will handle reading and
    // writing from alerts-as-data indices and eventually
    // we will want to migrate all the processing of alerts out
    // of the LegacyAlertsClient and into the AlertsClient.
    let alertsClient: IAlertsClient<
      AlertData,
      AlertState,
      Context,
      ActionGroupIds,
      RecoveryActionGroupId
    >;

    try {
      const client =
        (await this.context.alertsService?.createAlertsClient<
          AlertData,
          AlertState,
          Context,
          ActionGroupIds,
          RecoveryActionGroupId
        >({
          ...alertsClientParams,
          namespace: namespace ?? DEFAULT_NAMESPACE_STRING,
          rule: this.getAADRuleData(rule, spaceId),
        })) ?? null;

      alertsClient = client
        ? client
        : new LegacyAlertsClient<AlertState, Context, ActionGroupIds, RecoveryActionGroupId>(
            alertsClientParams
          );
    } catch (err) {
      this.logger.error(
        `Error initializing AlertsClient for context ${this.ruleType.alerts?.context}. Using legacy alerts client instead. - ${err.message}`
      );

      alertsClient = new LegacyAlertsClient<
        AlertState,
        Context,
        ActionGroupIds,
        RecoveryActionGroupId
      >(alertsClientParams);
    }

    await alertsClient.initializeExecution({
      maxAlerts: this.maxAlerts,
      ruleLabel,
      flappingSettings,
      startedAt: this.taskInstance.startedAt!,
      activeAlertsFromState: alertRawInstances,
      recoveredAlertsFromState: alertRecoveredRawInstances,
    });

    const wrappedClientOptions = {
      rule: {
        name: rule.name,
        alertTypeId: rule.alertTypeId,
        id: rule.id,
        spaceId,
      },
      logger: this.logger,
      abortController: this.searchAbortController,
    };
    const scopedClusterClient = this.context.elasticsearch.client.asScoped(fakeRequest);
    const wrappedScopedClusterClient = createWrappedScopedClusterClientFactory({
      ...wrappedClientOptions,
      scopedClusterClient,
    });
    const searchSourceClient = await this.context.data.search.searchSource.asScoped(fakeRequest);
    const wrappedSearchSourceClient = wrapSearchSourceClient({
      ...wrappedClientOptions,
      searchSourceClient,
    });
    const maintenanceWindowClient = this.context.getMaintenanceWindowClientWithRequest(fakeRequest);

    let activeMaintenanceWindows: MaintenanceWindow[] = [];
    try {
      activeMaintenanceWindows = await maintenanceWindowClient.getActiveMaintenanceWindows();
    } catch (err) {
      this.logger.error(
        `error getting active maintenance window for ${ruleTypeId}:${ruleId} ${err.message}`
      );
    }

    const maintenanceWindowIds = activeMaintenanceWindows
      .filter(({ categoryIds }) => {
        // If category IDs array doesn't exist: allow all
        if (!Array.isArray(categoryIds)) {
          return true;
        }
        // If category IDs array exist: check category
        if ((categoryIds as string[]).includes(ruleType.category)) {
          return true;
        }
        return false;
      })
      .map(({ id }) => id);

    if (maintenanceWindowIds.length) {
      this.alertingEventLogger.setMaintenanceWindowIds(maintenanceWindowIds);
    }

    const { updatedRuleTypeState } = await this.timer.runWithTimer(
      TaskRunnerTimerSpan.RuleTypeRun,
      async () => {
        const checkHasReachedAlertLimit = () => {
          const reachedLimit = alertsClient.hasReachedAlertLimit() || false;
          if (reachedLimit) {
            this.logger.warn(
              `rule execution generated greater than ${this.maxAlerts} alerts: ${ruleLabel}`
            );
            ruleRunMetricsStore.setHasReachedAlertLimit(true);
          }
          return reachedLimit;
        };

        let executorResult: { state: RuleState } | undefined;
        try {
          const ctx = {
            type: 'alert',
            name: `execute ${rule.alertTypeId}`,
            id: ruleId,
            description: `execute [${rule.alertTypeId}] with name [${name}] in [${
              namespace ?? 'default'
            }] namespace`,
          };

          const savedObjectsClient = this.context.savedObjects.getScopedClient(fakeRequest, {
            includedHiddenTypes: ['alert', 'action'],
          });

          const dataViews = await this.context.dataViews.dataViewsServiceFactory(
            savedObjectsClient,
            scopedClusterClient.asInternalUser
          );

          executorResult = await this.context.executionContext.withContext(ctx, () =>
            this.ruleType.executor({
              executionId: this.executionId,
              services: {
                savedObjectsClient,
                searchSourceClient: wrappedSearchSourceClient.searchSourceClient,
                uiSettingsClient: this.context.uiSettings.asScopedToClient(savedObjectsClient),
                scopedClusterClient: wrappedScopedClusterClient.client(),
                alertFactory: alertsClient.factory(),
                alertsClient: alertsClient.client(),
                shouldWriteAlerts: () => this.shouldLogAndScheduleActionsForAlerts(),
                shouldStopExecution: () => this.cancelled,
                ruleMonitoringService: this.ruleMonitoring.getLastRunMetricsSetters(),
                dataViews,
                share: this.context.share,
                ruleResultService: this.ruleResult.getLastRunSetters(),
              },
              params,
              state: ruleTypeState as RuleState,
              startedAt: this.taskInstance.startedAt!,
              previousStartedAt: previousStartedAt ? new Date(previousStartedAt) : null,
              spaceId,
              namespace,
              rule: {
                id: ruleId,
                name,
                tags,
                consumer,
                producer: ruleType.producer,
                revision,
                ruleTypeId: rule.alertTypeId,
                ruleTypeName: ruleType.name,
                enabled,
                schedule,
                actions,
                createdBy,
                updatedBy,
                createdAt,
                updatedAt,
                throttle,
                notifyWhen,
                muteAll,
                snoozeSchedule,
              },
              logger: this.logger,
              flappingSettings,
              ...(maintenanceWindowIds.length ? { maintenanceWindowIds } : {}),
              getTimeRange: (timeWindow) =>
                getTimeRange(this.logger, queryDelaySettings, timeWindow),
            })
          );

          // Rule type execution has successfully completed
          // Check that the rule type either never requested the max alerts limit
          // or requested it and then reported back whether it exceeded the limit
          // If neither of these apply, this check will throw an error
          // These errors should show up during rule type development
          alertsClient.checkLimitUsage();
        } catch (err) {
          // Check if this error is due to reaching the alert limit
          if (!checkHasReachedAlertLimit()) {
            this.alertingEventLogger.setExecutionFailed(
              `rule execution failure: ${ruleLabel}`,
              err.message
            );
            this.stackTraceLog = {
              message: err,
              stackTrace: err.stack,
            };
            throw new ErrorWithReason(RuleExecutionStatusErrorReasons.Execute, err);
          }
        }

        // Check if the rule type has reported that it reached the alert limit
        checkHasReachedAlertLimit();

        this.alertingEventLogger.setExecutionSucceeded(`rule executed: ${ruleLabel}`);
        ruleRunMetricsStore.setSearchMetrics([
          wrappedScopedClusterClient.getMetrics(),
          wrappedSearchSourceClient.getMetrics(),
        ]);

        return {
          updatedRuleTypeState: executorResult?.state || undefined,
        };
      }
    );

    await this.timer.runWithTimer(TaskRunnerTimerSpan.ProcessAlerts, async () => {
      alertsClient.processAndLogAlerts({
        eventLogger: this.alertingEventLogger,
        ruleRunMetricsStore,
        shouldLogAlerts: this.shouldLogAndScheduleActionsForAlerts(),
        flappingSettings,
        notifyOnActionGroupChange:
          notifyWhen === RuleNotifyWhen.CHANGE ||
          some(actions, (action) => action.frequency?.notifyWhen === RuleNotifyWhen.CHANGE),
        maintenanceWindowIds,
      });
    });

    await this.timer.runWithTimer(TaskRunnerTimerSpan.PersistAlerts, async () => {
      await alertsClient.persistAlerts();
    });

    const executionHandler = new ExecutionHandler({
      rule,
      ruleType: this.ruleType,
      logger: this.logger,
      taskRunnerContext: this.context,
      taskInstance: this.taskInstance,
      ruleRunMetricsStore,
      apiKey,
      ruleConsumer: this.ruleConsumer!,
      executionId: this.executionId,
      ruleLabel,
      previousStartedAt: previousStartedAt ? new Date(previousStartedAt) : null,
      alertingEventLogger: this.alertingEventLogger,
      actionsClient: await this.context.actionsPlugin.getActionsClientWithRequest(fakeRequest),
      maintenanceWindowIds,
      alertsClient,
    });

    let executionHandlerRunResult: RunResult = { throttledSummaryActions: {} };

    await this.timer.runWithTimer(TaskRunnerTimerSpan.TriggerActions, async () => {
      if (isRuleSnoozed(rule)) {
        this.logger.debug(`no scheduling of actions for rule ${ruleLabel}: rule is snoozed.`);
      } else if (!this.shouldLogAndScheduleActionsForAlerts()) {
        this.logger.debug(
          `no scheduling of actions for rule ${ruleLabel}: rule execution has been cancelled.`
        );
        this.countUsageOfActionExecutionAfterRuleCancellation();
      } else {
        executionHandlerRunResult = await executionHandler.run({
          ...alertsClient.getProcessedAlerts('activeCurrent'),
          ...alertsClient.getProcessedAlerts('recoveredCurrent'),
        });
      }
    });

    let alertsToReturn: Record<string, RawAlertInstance> = {};
    let recoveredAlertsToReturn: Record<string, RawAlertInstance> = {};

    // Only serialize alerts into task state if we're auto-recovering, otherwise
    // we don't need to keep this information around.
    if (this.ruleType.autoRecoverAlerts) {
      const { alertsToReturn: alerts, recoveredAlertsToReturn: recovered } =
        alertsClient.getAlertsToSerialize();
      alertsToReturn = alerts;
      recoveredAlertsToReturn = recovered;
    }

    return {
      metrics: ruleRunMetricsStore.getMetrics(),
      alertTypeState: updatedRuleTypeState || undefined,
      alertInstances: alertsToReturn,
      alertRecoveredInstances: recoveredAlertsToReturn,
      summaryActions: executionHandlerRunResult.throttledSummaryActions,
    };
  }

  /**
   * Initialize event logger, load and validate the rule
   */
  private async prepareToRun(): Promise<ValidatedRuleData<Params>> {
    if (!this.ruleData) {
      this.ruleData = await this.loadIndirectParams();
    }

    const {
      params: { alertId: ruleId, spaceId, consumer },
    } = this.taskInstance;

    if (apm.currentTransaction) {
      apm.currentTransaction.name = `Execute Alerting Rule`;
      apm.currentTransaction.addLabels({
        alerting_rule_space_id: spaceId,
        alerting_rule_id: ruleId,
      });
    }

    // Initially use consumer as stored inside the task instance
    // Replace this with consumer as read from the rule saved object after
    // we successfully read the rule SO. This allows us to populate a consumer
    // value for `execute-start` events (which are written before the rule SO is read)
    // and in the event of decryption errors (where we cannot read the rule SO)
    // Because "consumer" is set when a rule is created, this value should be static
    // for the life of a rule but there may be edge cases where migrations cause
    // the consumer values to become out of sync.
    if (consumer) {
      this.ruleConsumer = consumer;
    }

    const namespace = this.context.spaceIdToNamespace(spaceId);

    this.alertingEventLogger.initialize({
      ruleId,
      ruleType: this.ruleType as UntypedNormalizedRuleType,
      consumer: this.ruleConsumer!,
      spaceId,
      executionId: this.executionId,
      taskScheduledAt: this.taskInstance.scheduledAt,
      ...(namespace ? { namespace } : {}),
    });

    this.alertingEventLogger.start(this.runDate);

    return validateRule({
      alertingEventLogger: this.alertingEventLogger,
      ruleData: this.ruleData,
      paramValidator: this.ruleType.validate.params,
      ruleId,
      spaceId,
      context: this.context,
      ruleTypeRegistry: this.ruleTypeRegistry,
    });
  }

  private async processRunResults({
    nextRun,
    stateWithMetrics,
  }: {
    nextRun: string | null;
    stateWithMetrics: Result<RuleTaskStateAndMetrics, Error>;
  }) {
    const {
      params: { alertId: ruleId, spaceId },
    } = this.taskInstance;

    const namespace = this.context.spaceIdToNamespace(spaceId);

    // Getting executionStatus for backwards compatibility
    const { status: executionStatus } = map<
      RuleTaskStateAndMetrics,
      ElasticsearchError,
      IExecutionStatusAndMetrics
    >(
      stateWithMetrics,
      (ruleRunStateWithMetrics) => executionStatusFromState(ruleRunStateWithMetrics, this.runDate),
      (err: ElasticsearchError) => executionStatusFromError(err, this.runDate)
    );

    // New consolidated statuses for lastRun
    const { lastRun, metrics: executionMetrics } = map<
      RuleTaskStateAndMetrics,
      ElasticsearchError,
      ILastRun
    >(
      stateWithMetrics,
      (ruleRunStateWithMetrics) => lastRunFromState(ruleRunStateWithMetrics, this.ruleResult),
      (err: ElasticsearchError) => lastRunFromError(err)
    );

    if (apm.currentTransaction) {
      if (executionStatus.status === 'ok' || executionStatus.status === 'active') {
        apm.currentTransaction.setOutcome('success');
      } else if (executionStatus.status === 'error' || executionStatus.status === 'unknown') {
        apm.currentTransaction.setOutcome('failure');
      } else if (lastRun.outcome === 'succeeded') {
        apm.currentTransaction.setOutcome('success');
      } else if (lastRun.outcome === 'failed') {
        apm.currentTransaction.setOutcome('failure');
      }
    }

    this.logger.debug(
      `deprecated ruleRunStatus for ${this.ruleType.id}:${ruleId}: ${JSON.stringify(
        executionStatus
      )}`
    );
    this.logger.debug(
      `ruleRunStatus for ${this.ruleType.id}:${ruleId}: ${JSON.stringify(lastRun)}`
    );
    if (executionMetrics) {
      this.logger.debug(
        `ruleRunMetrics for ${this.ruleType.id}:${ruleId}: ${JSON.stringify(executionMetrics)}`
      );
    }

    // set start and duration based on event log
    const { start, duration } = this.alertingEventLogger.getStartAndDuration();
    if (null != start) {
      executionStatus.lastExecutionDate = start;
    }
    if (null != duration) {
      executionStatus.lastDuration = nanosToMillis(duration);
    }

    // if executionStatus indicates an error, fill in fields in
    this.ruleMonitoring.addHistory({
      duration: executionStatus.lastDuration,
      hasError: executionStatus.error != null,
      runDate: this.runDate,
    });

    if (!this.cancelled) {
      this.inMemoryMetrics.increment(IN_MEMORY_METRICS.RULE_EXECUTIONS);
      if (lastRun.outcome === 'failed') {
        this.inMemoryMetrics.increment(IN_MEMORY_METRICS.RULE_FAILURES);
      } else if (executionStatus.error) {
        this.inMemoryMetrics.increment(IN_MEMORY_METRICS.RULE_FAILURES);
      }
      this.logger.debug(
        `Updating rule task for ${this.ruleType.id} rule with id ${ruleId} - ${JSON.stringify(
          executionStatus
        )} - ${JSON.stringify(lastRun)}`
      );
      await this.updateRuleSavedObjectPostRun(ruleId, namespace, {
        executionStatus: ruleExecutionStatusToRaw(executionStatus),
        nextRun,
        lastRun: lastRunToRaw(lastRun),
        monitoring: this.ruleMonitoring.getMonitoring() as RawRuleMonitoring,
      });
    }

    return { executionStatus, executionMetrics };
  }

  async loadIndirectParams(): Promise<RuleDataResult<RuleData<Params>>> {
    this.runDate = new Date();
    return await this.timer.runWithTimer(TaskRunnerTimerSpan.PrepareRule, async () => {
      try {
        const {
          params: { alertId: ruleId, spaceId },
        } = this.taskInstance;
        const data = await getRuleAttributes<Params>(this.context, ruleId, spaceId);
        this.ruleData = { data };
      } catch (err) {
        const error = new ErrorWithReason(RuleExecutionStatusErrorReasons.Decrypt, err);
        this.ruleData = { error };
      }
      return this.ruleData;
    });
  }

  async run(): Promise<RuleTaskRunResult> {
    const {
      params: { alertId: ruleId, spaceId },
      startedAt,
      state: originalState,
      schedule: taskSchedule,
    } = this.taskInstance;

    this.ruleRunning.start(ruleId, this.context.spaceIdToNamespace(spaceId));

    this.logger.debug(
      `executing rule ${this.ruleType.id}:${ruleId} at ${this.runDate.toISOString()}`
    );

    if (startedAt) {
      // Capture how long it took for the rule to start running after being claimed
      this.timer.setDuration(TaskRunnerTimerSpan.StartTaskRun, startedAt);
    }

    let stateWithMetrics: Result<RuleTaskStateAndMetrics, Error>;
    let schedule: Result<IntervalSchedule, Error>;
    try {
      const preparedResult = await this.prepareToRun();

      this.ruleMonitoring.setMonitoring(preparedResult.rule.monitoring);

      (async () => {
        try {
          await preparedResult.rulesClient.clearExpiredSnoozes({
            rule: preparedResult.rule,
            version: preparedResult.version,
          });
        } catch (e) {
          // Most likely a 409 conflict error, which is ok, we'll try again at the next rule run
          this.logger.debug(`Failed to clear expired snoozes: ${e.message}`);
        }
      })();

      stateWithMetrics = asOk(await this.runRule(preparedResult));

      // fetch the rule again to ensure we return the correct schedule as it may have
      // changed during the task execution
      const attributes = await getRuleAttributes<Params>(this.context, ruleId, spaceId);
      schedule = asOk(attributes.rule.schedule);
    } catch (err) {
      stateWithMetrics = asErr(err);
      schedule = asErr(err);
    }

    let nextRun: string | null = null;
    if (isOk(schedule)) {
      nextRun = getNextRun({ startDate: startedAt, interval: schedule.value.interval });
    } else if (taskSchedule) {
      nextRun = getNextRun({ startDate: startedAt, interval: taskSchedule.interval });
    }

    const { executionStatus, executionMetrics } = await this.timer.runWithTimer(
      TaskRunnerTimerSpan.ProcessRuleRun,
      async () =>
        this.processRunResults({
          nextRun,
          stateWithMetrics,
        })
    );

    const transformRunStateToTaskState = (
      runStateWithMetrics: RuleTaskStateAndMetrics
    ): RuleTaskState => {
      return {
        ...omit(runStateWithMetrics, ['metrics']),
        previousStartedAt: startedAt?.toISOString(),
      };
    };

    if (startedAt) {
      // Capture how long it took for the rule to run after being claimed
      this.timer.setDuration(TaskRunnerTimerSpan.TotalRunDuration, startedAt);
    }

    this.alertingEventLogger.done({
      status: executionStatus,
      metrics: executionMetrics,
      timings: this.timer.toJson(),
    });

    return {
      state: map<RuleTaskStateAndMetrics, ElasticsearchError, RuleTaskState>(
        stateWithMetrics,
        (ruleRunStateWithMetrics: RuleTaskStateAndMetrics) =>
          transformRunStateToTaskState(ruleRunStateWithMetrics),
        (err: ElasticsearchError) => {
          if (isAlertSavedObjectNotFoundError(err, ruleId)) {
            const message = `Executing Rule ${spaceId}:${
              this.ruleType.id
            }:${ruleId} has resulted in Error: ${getEsErrorMessage(err)}`;
            this.logger.debug(message);
          } else {
            const error = this.stackTraceLog ? this.stackTraceLog.message : err;
            const stack = this.stackTraceLog ? this.stackTraceLog.stackTrace : err.stack;
            const message = `Executing Rule ${spaceId}:${
              this.ruleType.id
            }:${ruleId} has resulted in Error: ${getEsErrorMessage(error)} - ${stack ?? ''}`;
            this.logger.error(message, {
              tags: [this.ruleType.id, ruleId, 'rule-run-failed'],
              error: { stack_trace: stack },
            });
          }
          return originalState;
        }
      ),
      schedule: resolveErr<IntervalSchedule | undefined, Error>(schedule, (error) => {
        if (isAlertSavedObjectNotFoundError(error, ruleId)) {
          const spaceMessage = spaceId ? `in the "${spaceId}" space ` : '';
          this.logger.warn(
            `Unable to execute rule "${ruleId}" ${spaceMessage}because ${error.message} - this rule will not be rescheduled. To restart rule execution, try disabling and re-enabling this rule.`
          );
          throwUnrecoverableError(error);
        }

        let retryInterval = taskSchedule?.interval ?? FALLBACK_RETRY_INTERVAL;

        // Set retry interval smaller for ES connectivity errors
        if (isEsUnavailableError(error, ruleId)) {
          retryInterval =
            parseDuration(retryInterval) > parseDuration(CONNECTIVITY_RETRY_INTERVAL)
              ? CONNECTIVITY_RETRY_INTERVAL
              : retryInterval;
        }

        return { interval: retryInterval };
      }),
      monitoring: this.ruleMonitoring.getMonitoring(),
      ...(isErr(schedule)
        ? { taskRunError: createTaskRunError(schedule.error, TaskErrorSource.FRAMEWORK) }
        : {}),
    };
  }

  async cancel(): Promise<void> {
    if (this.cancelled) {
      return;
    }

    this.cancelled = true;

    // Write event log entry
    const {
      params: { alertId: ruleId, spaceId, consumer },
      schedule: taskSchedule,
      startedAt,
    } = this.taskInstance;
    const namespace = this.context.spaceIdToNamespace(spaceId);

    if (consumer && !this.ruleConsumer) {
      this.ruleConsumer = consumer;
    }

    this.logger.debug(
      `Cancelling rule type ${this.ruleType.id} with id ${ruleId} - execution exceeded rule type timeout of ${this.ruleType.ruleTaskTimeout}`
    );

    this.logger.debug(
      `Aborting any in-progress ES searches for rule type ${this.ruleType.id} with id ${ruleId}`
    );
    this.searchAbortController.abort();

    this.alertingEventLogger.logTimeout();

    this.inMemoryMetrics.increment(IN_MEMORY_METRICS.RULE_TIMEOUTS);

    let nextRun: string | null = null;
    if (taskSchedule) {
      nextRun = getNextRun({ startDate: startedAt, interval: taskSchedule.interval });
    }

    const outcomeMsg = [
      `${this.ruleType.id}:${ruleId}: execution cancelled due to timeout - exceeded rule type timeout of ${this.ruleType.ruleTaskTimeout}`,
    ];
    const date = new Date();
    // Update the rule saved object with execution status
    const executionStatus: RuleExecutionStatus = {
      lastExecutionDate: date,
      status: 'error',
      error: {
        reason: RuleExecutionStatusErrorReasons.Timeout,
        message: outcomeMsg.join(' '),
      },
    };
    this.logger.debug(
      `Updating rule task for ${this.ruleType.id} rule with id ${ruleId} - execution error due to timeout`
    );
    const outcome = 'failed';
    await this.updateRuleSavedObjectPostRun(ruleId, namespace, {
      executionStatus: ruleExecutionStatusToRaw(executionStatus),
      lastRun: {
        outcome,
        outcomeOrder: RuleLastRunOutcomeOrderMap[outcome],
        warning: RuleExecutionStatusErrorReasons.Timeout,
        outcomeMsg,
        alertsCount: {},
      },
      monitoring: this.ruleMonitoring.getMonitoring() as RawRuleMonitoring,
      nextRun: nextRun && new Date(nextRun).getTime() > date.getTime() ? nextRun : null,
    });
  }
}
