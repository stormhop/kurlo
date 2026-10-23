<script lang="ts">
  import { BIRD_BODY, BIRD_EYE, BIRD_LEGS, BIRD_STRIPE, BIRD_WING } from '../bird';

  let {
    mode = 'perched',
    envelope = false,
    size = '3rem',
  }: {
    mode?: 'perched' | 'flying';
    envelope?: boolean;
    size?: string;
  } = $props();

  let height = $derived(envelope ? 560 : 460);
</script>

<svg
  class="kurlo-bird kurlo-bird-{mode}"
  viewBox="220 290 580 {height}"
  style={`width: ${size}; aspect-ratio: 580 / ${height}`}
  aria-hidden="true"
  focusable="false"
>
  <g class="kurlo-bird-bob">
    {#if envelope}
      <g transform="translate(495 752) rotate(-5)">
        <rect class="kurlo-bird-envelope" x="-62" y="0" width="124" height="82" rx="6" />
        <path class="kurlo-bird-envelope-flap" d="M -62 2 L 0 44 L 62 2" />
      </g>
    {/if}
    {#each BIRD_LEGS as leg (leg.x)}
      <rect class="kurlo-bird-body" x={leg.x} y={leg.y} width={leg.width} height={leg.height} rx="12" />
    {/each}
    <path class="kurlo-bird-body" d={BIRD_BODY} />
    <path class="kurlo-bird-stripe" d={BIRD_STRIPE} />
    <circle class="kurlo-bird-eye" cx={BIRD_EYE.cx} cy={BIRD_EYE.cy} r={BIRD_EYE.r} />
    <path class="kurlo-bird-wing" d={BIRD_WING} />
  </g>
</svg>

<style>
  .kurlo-bird {
    display: block;
    flex-shrink: 0;
    overflow: visible;
  }
  .kurlo-bird-body {
    fill: var(--accent);
  }
  .kurlo-bird-stripe {
    fill: none;
    stroke: color-mix(in srgb, var(--accent) 45%, white);
    stroke-width: 34;
    stroke-linecap: round;
  }
  .kurlo-bird-wing {
    fill: color-mix(in srgb, var(--accent) 45%, white);
    transform-box: fill-box;
    transform-origin: 88% 18%;
  }
  .kurlo-bird-eye {
    fill: #ffffff;
    transform-box: fill-box;
    transform-origin: center;
    animation: kurlo-bird-blink 4.5s infinite;
  }
  .kurlo-bird-envelope {
    fill: #f7f3ea;
    stroke: #d9cfb8;
    stroke-width: 4;
  }
  .kurlo-bird-envelope-flap {
    fill: none;
    stroke: #b9ad93;
    stroke-width: 6;
    stroke-linejoin: round;
  }
  .kurlo-bird-perched .kurlo-bird-bob {
    animation: kurlo-bird-bob 2.6s ease-in-out infinite;
  }
  .kurlo-bird-flying .kurlo-bird-bob {
    animation: kurlo-bird-bob 0.9s ease-in-out infinite;
  }
  .kurlo-bird-flying .kurlo-bird-wing {
    animation: kurlo-bird-flap 0.18s ease-in-out infinite alternate;
  }

  @keyframes kurlo-bird-bob {
    50% { transform: translateY(-3%); }
  }
  @keyframes kurlo-bird-flap {
    from { transform: rotate(-10deg); }
    to { transform: rotate(42deg) scaleY(0.75); }
  }
  @keyframes kurlo-bird-blink {
    0%, 93%, 100% { transform: scaleY(1); }
    96% { transform: scaleY(0.1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .kurlo-bird-bob,
    .kurlo-bird-wing,
    .kurlo-bird-eye {
      animation: none !important;
    }
  }
</style>
