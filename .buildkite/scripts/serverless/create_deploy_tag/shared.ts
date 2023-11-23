/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import axios from 'axios';

import { getExec } from './mock_exec';
import { GitCommitExtract } from './info_sections/commit_info';
import { BuildkiteBuildExtract } from './info_sections/build_info';
import { BuildkiteClient, getGithubClient } from '#pipeline-utils';

const SELECTED_COMMIT_META_KEY = 'selected-commit-hash';
const DEPLOY_TAG_META_KEY = 'deploy-tag';
const COMMIT_INFO_CTX = 'commit-info';

const octokit = getGithubClient();

const exec = getExec(!process.env.CI);

const buildkite = new BuildkiteClient({ exec });

const buildStateToEmoji = (state: string) => {
  return (
    {
      failure: '❌',
      pending: '⏳',
      success: '✅',
    }[state] || '❓'
  );
};

const buildkiteBuildStateToEmoji = (state: string) => {
  return (
    {
      running: '⏳',
      scheduled: '⏳',
      passed: '✅',
      failed: '❌',
      blocked: '❌',
      canceled: '❌',
      canceling: '❌',
      skipped: '❌',
      not_run: '❌',
      finished: '✅',
    }[state] || '❓'
  );
};

export {
  octokit,
  exec,
  buildkite,
  buildStateToEmoji,
  buildkiteBuildStateToEmoji,
  SELECTED_COMMIT_META_KEY,
  COMMIT_INFO_CTX,
  DEPLOY_TAG_META_KEY,
};

export interface CommitWithStatuses extends GitCommitExtract {
  title: string;
  author: string | undefined;
  checks: {
    onMergeBuild: BuildkiteBuildExtract | null;
    ftrBuild: BuildkiteBuildExtract | null;
    artifactBuild: BuildkiteBuildExtract | null;
  };
}

export function sendSlackMessage(payload: any) {
  if (process.env.DEPLOY_TAGGER_SLACK_WEBHOOK_URL) {
    return axios.post(
      process.env.DEPLOY_TAGGER_SLACK_WEBHOOK_URL,
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    );
  } else {
    console.log('No SLACK_WEBHOOK_URL set, not sending slack message');
    return Promise.resolve();
  }
}
