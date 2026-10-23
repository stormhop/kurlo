<script lang="ts">
  import night from '../assets/about-night.webp';
  import { BIRD_BODY, BIRD_CENTER, BIRD_EYE, BIRD_LEGS, BIRD_STRIPE, BIRD_WING } from '../bird';

  const wire = { x0: -40, y0: 520, cx: 800, cy: 660, x1: 1640, y1: 470 };
  const t = 0.6;
  const perch = {
    x: (1 - t) ** 2 * wire.x0 + 2 * (1 - t) * t * wire.cx + t ** 2 * wire.x1,
    y: (1 - t) ** 2 * wire.y0 + 2 * (1 - t) * t * wire.cy + t ** 2 * wire.y1,
  };
  const scale = 0.27;
  const feet = BIRD_LEGS[0].y + BIRD_LEGS[0].height;
  const birdTransform = `translate(${perch.x.toFixed(1)} ${(perch.y - scale * (feet - BIRD_CENTER.y)).toFixed(1)}) scale(${scale}) translate(${-BIRD_CENTER.x} ${-BIRD_CENTER.y})`;
</script>

<div class="about-night" aria-hidden="true">
  <img src={night} alt="" draggable="false" />
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
    <g transform={birdTransform}>
      <g class="about-night-bird">
        {#each BIRD_LEGS as leg (leg.x)}
          <rect class="about-night-body" x={leg.x} y={leg.y} width={leg.width} height={leg.height} rx="12" />
        {/each}
        <path class="about-night-body" d={BIRD_BODY} />
        <path class="about-night-stripe" d={BIRD_STRIPE} />
        <circle class="about-night-eye" cx={BIRD_EYE.cx} cy={BIRD_EYE.cy} r={BIRD_EYE.r} />
        <path class="about-night-wing" d={BIRD_WING} />
      </g>
    </g>
  </svg>
</div>

<style>
  .about-night {
    position: relative;
    box-sizing: border-box;
    width: 100%;
    max-width: 26.25rem;
    aspect-ratio: 5 / 2;
    margin-bottom: var(--space-4);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: #0b0c26;
    user-select: none;
  }
  .about-night img,
  .about-night svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .about-night img {
    object-fit: cover;
    object-position: 50% 50%;
    -webkit-user-drag: none;
  }
  .about-night-body {
    fill: var(--accent);
  }
  .about-night-stripe {
    fill: none;
    stroke: color-mix(in srgb, var(--accent) 45%, white);
    stroke-width: 34;
    stroke-linecap: round;
  }
  .about-night-wing {
    fill: color-mix(in srgb, var(--accent) 45%, white);
  }
  .about-night-eye {
    fill: #ffffff;
    transform-box: fill-box;
    transform-origin: center;
    animation: about-night-blink 5s infinite;
  }
  .about-night-bird {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: about-night-breathe 3.2s ease-in-out infinite;
  }

  @keyframes about-night-blink {
    0%, 92%, 100% { transform: scaleY(1); }
    95% { transform: scaleY(0.1); }
  }
  @keyframes about-night-breathe {
    50% { transform: scale(1.02, 0.98); }
  }

  @media (prefers-reduced-motion: reduce) {
    .about-night-eye,
    .about-night-bird {
      animation: none;
    }
  }
</style>
