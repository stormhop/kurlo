import { SvelteMap } from 'svelte/reactivity';
import { listenRuntime } from '../runtimeEvents';
import type { KafkaRecord } from '../kafka';

export const kafkaDiscovery = $state({ topics: [] as string[], busy: false, tested: false, error: '' });
export const kafkaStreams = new SvelteMap<string, KafkaRecord[]>();

const owners = new SvelteMap<string, object>();

export function openKafkaStream(id: string, eventId: string) {
  kafkaStreams.set(id, []);
  const stream = {};
  owners.set(id, stream);
  const off = listenRuntime<KafkaRecord[]>('kafka:records:' + eventId, records => {
    const current = kafkaStreams.get(id);
    if (current && owners.get(id) === stream) kafkaStreams.set(id, current.concat(records));
  });
  return () => {
    off();
    if (owners.get(id) === stream) {
      owners.delete(id);
      kafkaStreams.delete(id);
    }
  };
}
