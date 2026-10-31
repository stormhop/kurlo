import { describe, expect, it } from 'vitest';
import { loadCheckErrors, loadExtractErrors, loadStepErrors, loadStepStructuralErrors } from '../lib/loadFlowErrors';

describe('load flow error placement', () => {
  it('puts extraction errors on the matching row and field', () => {
    const problems = ['Step 1: "" is not a valid variable name. Use letters, digits and _, not starting with a digit.', 'Step 1: the JSON path for token must start with $.', 'Step 2 has no request.'];
    const step = loadStepErrors(problems, 0);
    expect(loadExtractErrors(step, { var: '', from: 'json', path: '$.' }).name).toEqual([problems[0]]);
    expect(loadExtractErrors(step, { var: 'token', from: 'json', path: 'token' }).path).toEqual([problems[1]]);
    expect(loadExtractErrors(step, { var: 'other', from: 'json', path: '$.id' })).toEqual({ name: [], path: [], source: [] });
    expect(loadStepStructuralErrors(step)).toEqual([]);
    expect(loadStepStructuralErrors(loadStepErrors(problems, 1))).toEqual([problems[2]]);
  });

  it('keeps invalid checks next to their own rows', () => {
    const problems = ['Step 1: the expected status must be a number from 100 to 599.', 'Step 1: the JSON path to check must start with $.'];
    expect(loadCheckErrors(problems, { type: 'status', value: '200' })).toEqual([]);
    expect(loadCheckErrors(problems, { type: 'status', value: '+200' })).toEqual([]);
    expect(loadCheckErrors(problems, { type: 'status', value: '999' })).toEqual([problems[0]]);
    expect(loadCheckErrors(problems, { type: 'jsonExists', path: 'id' })).toEqual([problems[1]]);
    expect(loadCheckErrors(problems, { type: 'jsonExists', path: '$.id' })).toEqual([]);
  });
});
