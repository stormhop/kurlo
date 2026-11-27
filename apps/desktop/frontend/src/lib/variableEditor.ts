import type { VariableSource } from './variables';

export type VariableEditor = {
  save: (key: string, value: string, source?: VariableSource) => Promise<void> | void;
  remove: (key: string, source: VariableSource) => Promise<void> | void;
  addTarget: () => VariableSource;
};

let current: VariableEditor | null = null;

export function registerVariableEditor(editor: VariableEditor) {
  current = editor;
  return () => {
    if (current === editor) current = null;
  };
}

export function variableEditor(): VariableEditor | null {
  return current;
}
