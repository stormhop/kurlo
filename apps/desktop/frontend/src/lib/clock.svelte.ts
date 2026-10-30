import { onMount } from 'svelte';

export function useClock() {
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  return () => now;
}
