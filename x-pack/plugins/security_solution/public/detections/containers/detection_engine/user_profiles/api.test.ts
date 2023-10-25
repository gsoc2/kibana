/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/public/mocks';

import { mockUserProfiles } from './mock';
import { suggestUsers } from './api';
import { KibanaServices } from '../../../../common/lib/kibana';

const mockKibanaServices = KibanaServices.get as jest.Mock;
jest.mock('../../../../common/lib/kibana');

const coreStartMock = coreMock.createStart({ basePath: '/mock' });
mockKibanaServices.mockReturnValue(coreStartMock);
const fetchMock = coreStartMock.http.fetch;

describe('Detections Alerts API', () => {
  describe('suggestUsers', () => {
    beforeEach(() => {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(mockUserProfiles);
    });

    test('check parameter url', async () => {
      await suggestUsers({ searchTerm: 'name1' });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/detection_engine/signals/suggest_users',
        expect.objectContaining({
          method: 'GET',
          version: '2023-10-31',
          query: { searchTerm: 'name1' },
        })
      );
    });

    test('happy path', async () => {
      const alertsResp = await suggestUsers({ searchTerm: '' });
      expect(alertsResp).toEqual(mockUserProfiles);
    });
  });
});
