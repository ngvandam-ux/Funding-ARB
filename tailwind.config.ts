import type { Config } from 'tailwindcss'

// Tailwind v4 — wired into CSS via `@config "../tailwind.config.ts"` in src/index.css.
// Dark theme tokens from SPEC §7.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0f', // page background
        fg: '#e5e7eb', // primary text
        magenta: '#e879f9', // accent
        cyan: '#22d3ee', // accent
      },
    },
  },
} satisfies Config
