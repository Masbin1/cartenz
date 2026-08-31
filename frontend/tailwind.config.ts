import type { Config } from 'tailwindcss';

/**
 * The portal is a developer environment, not a marketing site: a dark, dense,
 * low-chroma palette with one accent, so that status colour carries meaning
 * rather than competing with decoration.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0d1117',
          raised: '#151b23',
          overlay: '#1c232c',
          border: '#2a323d',
        },
        content: {
          DEFAULT: '#e6edf3',
          muted: '#9aa7b4',
          subtle: '#6b7684',
        },
        accent: {
          DEFAULT: '#c8102e',
          hover: '#a50d26',
          subtle: 'rgba(200, 16, 46, 0.12)',
        },
        state: {
          running: '#3b82f6',
          waiting: '#d97706',
          success: '#16a34a',
          failure: '#dc2626',
          idle: '#6b7684',
        },
      },
      fontFamily: {
        sans: ['Aptos', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
};

export default config;
