/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import { IndexedHostsAndAlertsResponse } from '@kbn/security-solution-plugin/common/endpoint/index_data';
import { FtrProviderContext } from '../../ftr_provider_context';
import { targetTags } from '../../target_tags';

export default ({ getPageObjects, getService }: FtrProviderContext) => {
  const pageObjects = getPageObjects(['common', 'trustedApps']);
  const testSubjects = getService('testSubjects');
  const browser = getService('browser');
  const endpointTestResources = getService('endpointTestResources');

  // FLAKY: https://github.com/elastic/kibana/issues/171481
  describe.skip('When on the Trusted Apps list', function () {
    targetTags(this, ['@ess', '@serverless']);

    let indexedData: IndexedHostsAndAlertsResponse;
    before(async () => {
      indexedData = await endpointTestResources.loadEndpointData();
      await browser.refresh();
      await pageObjects.trustedApps.navigateToTrustedAppsList();
    });
    after(async () => {
      await endpointTestResources.unloadEndpointData(indexedData);
    });

    it('should not show page title if there is no trusted app', async () => {
      await testSubjects.missingOrFail('header-page-title');
    });

    // FLAKY: https://github.com/elastic/kibana/issues/171481
    it.skip('should be able to add a new trusted app and remove it', async () => {
      const SHA256 = 'A4370C0CF81686C0B696FA6261c9d3e0d810ae704ab8301839dffd5d5112f476';

      // Add it
      await testSubjects.click('trustedAppsListPage-emptyState-addButton');
      await testSubjects.click('trustedApps-form-nameTextField');
      await testSubjects.setValue('trustedApps-form-nameTextField', 'Windows Defender');
      await testSubjects.click('trustedApps-form-conditionsBuilder-group1-entry0-value');
      await testSubjects.setValue('trustedApps-form-conditionsBuilder-group1-entry0-value', SHA256);
      await testSubjects.click('trustedAppsListPage-flyout-submitButton');
      expect(
        await testSubjects.getVisibleText('trustedAppsListPage-card-criteriaConditions-condition')
      ).to.equal(
        'AND process.hash.*IS a4370c0cf81686c0b696fa6261c9d3e0d810ae704ab8301839dffd5d5112f476'
      );
      await pageObjects.common.closeToast();

      // Title is shown after adding an item
      expect(await testSubjects.getVisibleText('header-page-title')).to.equal(
        'Trusted applications'
      );

      // Remove it
      await pageObjects.trustedApps.clickCardActionMenu();
      await testSubjects.click('trustedAppsListPage-card-cardDeleteAction');
      await testSubjects.click('trustedAppsListPage-deleteModal-submitButton');
      await testSubjects.waitForDeleted('trustedAppsListPage-deleteModal-submitButton');
      // We only expect one trusted app to have been visible
      await testSubjects.missingOrFail('trustedAppsListPage-card');
      // Header has gone because there is no trusted app
      await testSubjects.missingOrFail('header-page-title');
    });
  });
};
