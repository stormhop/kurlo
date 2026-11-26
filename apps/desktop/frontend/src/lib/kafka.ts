import type { HttpRequest } from './wire';

type KafkaWire = NonNullable<HttpRequest['kafka']>;
export type KafkaTopic = NonNullable<KafkaWire['topics']>[number];
export type KafkaConfig = Required<Omit<KafkaWire, 'topics'>> & { topics: KafkaTopic[] };

export function kafkaConfig(input?: KafkaWire): KafkaConfig {
  return {
    timestamp: input?.timestamp ?? '',
    schemaPath: input?.schemaPath ?? '',
    onMessage: input?.onMessage ?? '',
    mode: input?.mode || 'produce',
    topic: input?.topic ?? '',
    topics: (Array.isArray(input?.topics) ? input.topics : []).filter(t => typeof t?.name === 'string').map(t => ({ ...t })),
    key: input?.key ?? '',
    keyFormat: input?.keyFormat || 'text',
    partition: input?.partition ?? '',
    format: input?.format || 'json',
    acks: input?.acks || 'all',
    compression: input?.compression || 'none',
    tls: input?.tls ?? false,
    mechanism: input?.mechanism || 'PLAIN',
    startFrom: input?.startFrom || 'latest',
    startValue: input?.startValue ?? '',
    stopAfter: input?.stopAfter || 'records',
    stopValue: input?.stopValue ?? '1000',
  };
}

export type KafkaRecord = {
  topic: string;
  partition: number;
  offset?: string;
  timestamp: string;
  key: string | null;
  keyEncoding?: string;
  value: string | null;
  encoding?: string;
  validation?: string;
  schemaIssue?: string;
  headers: { key: string; value: string | null; encoding?: string }[];
};
