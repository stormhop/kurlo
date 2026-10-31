import type { LoadCheck, LoadExtract } from './wire';

export function loadStepErrors(problems: string[], index: number): string[] {
  return problems.filter(problem => problem.startsWith(`Step ${index + 1}:`) || problem.startsWith(`Step ${index + 1} `));
}

export function loadExtractErrors(problems: string[], extract: LoadExtract) {
  return {
    name: problems.filter(problem => problem.includes(`${JSON.stringify(extract.var)} is not a valid variable name`) || problem.includes(` saves ${extract.var}, which step `)),
    path: problems.filter(problem => problem.includes(`JSON path for ${extract.var} must `) || problem.includes(`header to save as ${extract.var}.`) || problem.includes(`pattern for ${extract.var} `)),
    source: problems.filter(problem => problem.includes('unknown source ') && problem.endsWith(` for ${extract.var}.`)),
  };
}

export function loadCheckErrors(problems: string[], check: LoadCheck): string[] {
  if (check.type === 'status') {
    const value = (check.value ?? '').trim();
    if (/^[+-]?\d+$/.test(value) && Number(value) >= 100 && Number(value) <= 599) return [];
    return problems.filter(problem => problem.includes('the expected status must be a number from 100 to 599.'));
  }
  if (check.type === 'jsonExists') return (check.path ?? '').trim().startsWith('$') ? [] : problems.filter(problem => problem.includes('the JSON path to check must start with $.'));
  if (check.type === 'bodyContains') return check.value ? [] : problems.filter(problem => problem.includes('enter the text the body must contain.'));
  return problems.filter(problem => problem.includes(`unknown check ${JSON.stringify(check.type)}.`));
}

export function loadStepStructuralErrors(problems: string[]): string[] {
  return problems.filter(problem => !/not a valid variable name| saves .*which step|JSON path for|header to save as|pattern for|unknown source|the expected status|JSON path to check|text the body must contain|unknown check|wait after the step/.test(problem));
}
