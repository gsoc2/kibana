/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { createReduxEmbeddableTools } from '@kbn/presentation-util-plugin/public/redux_embeddables/create_redux_embeddable_tools';

import { OptionsListEmbeddable, OptionsListEmbeddableFactory } from '../../public';
import { OptionsListComponentState, OptionsListReduxState } from '../../public/options_list/types';
import {
  getDefaultComponentState,
  optionsListReducers,
} from '../../public/options_list/options_list_reducers';
import { ControlFactory, ControlOutput } from '../../public/types';
import { OptionsListEmbeddableInput } from './types';

const mockOptionsListComponentState = {
  ...getDefaultComponentState(),
  field: undefined,
  totalCardinality: 0,
  availableOptions: [
    { value: 'woof', docCount: 100 },
    { value: 'bark', docCount: 75 },
    { value: 'meow', docCount: 50 },
    { value: 'quack', docCount: 25 },
    { value: 'moo', docCount: 5 },
  ],
  invalidSelections: [],
  validSelections: [],
} as OptionsListComponentState;

export const mockOptionsListEmbeddableInput = {
  id: 'sample options list',
  fieldName: 'sample field',
  dataViewId: 'sample id',
  selectedOptions: [],
  runPastTimeout: false,
  singleSelect: false,
  exclude: false,
} as OptionsListEmbeddableInput;

const mockOptionsListOutput = {
  loading: false,
} as ControlOutput;

export const mockOptionsListReduxEmbeddableTools = async (
  partialState?: Partial<OptionsListReduxState>
) => {
  const optionsListFactoryStub = new OptionsListEmbeddableFactory();
  const optionsListControlFactory = optionsListFactoryStub as unknown as ControlFactory;
  optionsListControlFactory.getDefaultInput = () => ({});
  const mockEmbeddable = (await optionsListControlFactory.create({
    ...mockOptionsListEmbeddableInput,
    ...partialState?.explicitInput,
  })) as OptionsListEmbeddable;
  mockEmbeddable.getOutput = jest.fn().mockReturnValue(mockOptionsListOutput);

  const mockReduxEmbeddableTools = createReduxEmbeddableTools<OptionsListReduxState>({
    embeddable: mockEmbeddable,
    reducers: optionsListReducers,
    initialComponentState: {
      ...mockOptionsListComponentState,
      ...partialState?.componentState,
    },
  });

  return mockReduxEmbeddableTools;
};
