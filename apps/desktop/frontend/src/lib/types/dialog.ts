export type DialogOption = {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: 'http' | 'graphql' | 'ws' | 'sio' | 'grpc' | 'mcp' | 'bruno' | 'postman' | 'insomnia' | 'openapi' | 'har' | 'httpfile';
  description?: string;
};

type DialogResult = string | boolean | null;

export type DialogToggle = { label: string; hint?: string; checked: boolean; warn?: boolean };

type AppDialogBase = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  placeholder?: string;
  maxLength?: number;
  resolve: (value?: DialogResult) => void;
};

export type AppDialogState =
  | (AppDialogBase & { mode: 'prompt'; options?: never; toggles?: DialogToggle[] })
  | (AppDialogBase & { mode: 'confirm'; options?: never })
  | (AppDialogBase & { mode: 'select'; options: DialogOption[] })
  | (AppDialogBase & { mode: 'alert'; options?: never })
  | (AppDialogBase & { mode: 'unsaved'; altLabel: string; options?: never });
