import type { Config } from 'tailwindcss';

/**
 * Cartenz: complex infrastructure, simple experience.
 *
 * A restrained neutral foundation with one accent. Colours are CSS variables
 * (defined in app/globals.css) so the same class names serve the light theme
 * and the dark one that follows the system setting, and so opacity modifiers
 * such as `bg-state-failure/10` keep working.
 *
 * The accent is for primary actions, the active navigation item, selection and
 * important links, not decoration. Status colours carry meaning only: blue is
 * working, amber needs you, green succeeded, red failed, grey is inert.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          // The page background. Content sits on it directly unless a group
          // genuinely needs containment.
          DEFAULT: token('surface'),
          // A contained group: panels, inputs, menus.
          raised: token('surface-raised'),
          // Hover and pressed fills, code wells, skeletons.
          overlay: token('surface-overlay'),
          border: token('surface-border'),
          strong: token('surface-strong'),
        },
        content: {
          DEFAULT: token('content'),
          muted: token('content-muted'),
          subtle: token('content-subtle'),
        },
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          subtle: 'rgb(var(--accent) / 0.08)',
        },
        state: {
          running: token('state-running'),
          waiting: token('state-waiting'),
          success: token('state-success'),
          failure: token('state-failure'),
          idle: token('state-idle'),
        },
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          '"Cascadia Mono"',
          'Menlo',
          'Consolas',
          '"DejaVu Sans Mono"',
          '"Liberation Mono"',
          'monospace',
        ],
      },
      /**
       * The type scale. Four information levels, each with its own size, weight
       * and colour: display and title for the primary, body for the secondary,
       * callout and meta for the supporting, caption for the tertiary.
       */
      fontSize: {
        display: ['2.5rem', { lineHeight: '3rem', letterSpacing: '-0.025em', fontWeight: '600' }],
        'display-sm': ['1.875rem', { lineHeight: '2.375rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        title: ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        headline: ['1.0625rem', { lineHeight: '1.5rem', letterSpacing: '-0.005em', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.5rem' }],
        callout: ['0.875rem', { lineHeight: '1.25rem' }],
        meta: ['0.8125rem', { lineHeight: '1.125rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        // Retained so that nothing renders smaller than the caption size.
        '2xs': ['0.75rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        control: '10px',
        card: '16px',
      },
      boxShadow: {
        // Reserved for floating layers (menus, drawers, dialogs). Surfaces on
        // the page use a border or whitespace, never a shadow.
        float: '0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -4px rgb(0 0 0 / 0.12)',
      },
      transitionDuration: {
        DEFAULT: '160ms',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'rise-in': 'rise-in 180ms ease-out',
        'slide-in': 'slide-in 200ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
