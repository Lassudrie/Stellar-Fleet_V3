const plugin = require('tailwindcss/plugin');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'fleet-blue': '#3b82f6',
        'fleet-red': '#ef4444',
        'fleet-blue-highlight': '#60a5fa',
        'fleet-red-highlight': '#f87171',
        'fleet-star': '#ffffff',
        'fleet-orbit': '#ffffff',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'zoom-in-95': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-from-left': {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-from-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-from-bottom': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'damage-float': {
          '0%': { transform: 'translateY(0) scale(1)', opacity: '1' },
          '100%': { transform: 'translateY(-30px) scale(1.2)', opacity: '0' },
        },
        'beam-fire': {
          '0%': { transform: 'scaleX(0)', opacity: '0.8' },
          '20%': { transform: 'scaleX(1)', opacity: '1' },
          '100%': { transform: 'scaleX(1)', opacity: '0' },
        },
        'hit-flash': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0)' },
          '10%': { backgroundColor: 'rgba(239, 68, 68, 0.5)' },
          '100%': { backgroundColor: 'rgba(239, 68, 68, 0)' },
        },
        shake: {
          '0%': { transform: 'translate(1px, 1px) rotate(0deg)' },
          '10%': { transform: 'translate(-1px, -2px) rotate(-1deg)' },
          '20%': { transform: 'translate(-3px, 0px) rotate(1deg)' },
          '30%': { transform: 'translate(3px, 2px) rotate(0deg)' },
          '40%': { transform: 'translate(1px, -1px) rotate(1deg)' },
          '50%': { transform: 'translate(-1px, 2px) rotate(-1deg)' },
          '60%': { transform: 'translate(-3px, 1px) rotate(0deg)' },
          '70%': { transform: 'translate(3px, 1px) rotate(-1deg)' },
          '80%': { transform: 'translate(-1px, -1px) rotate(1deg)' },
          '90%': { transform: 'translate(1px, 2px) rotate(0deg)' },
          '100%': { transform: 'translate(1px, -2px) rotate(-1deg)' },
        },
      },
      animation: {
        'damage-float': 'damage-float 0.8s ease-out forwards',
        beam: 'beam-fire 0.4s ease-out forwards',
        'beam-reverse': 'beam-fire 0.4s ease-out forwards',
        hit: 'hit-flash 0.3s ease-out',
        shake: 'shake 0.5s',
      },
    },
  },
  plugins: [
    plugin(function ({ addUtilities }) {
      addUtilities({
        '.animate-in': {
          animationFillMode: 'forwards',
          animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        },
        '.fade-in': { animationName: 'fade-in' },
        '.zoom-in-95': { animationName: 'zoom-in-95' },
        '.slide-in-from-left': { animationName: 'slide-in-from-left' },
        '.slide-in-from-right': { animationName: 'slide-in-from-right' },
        '.slide-in-from-bottom': { animationName: 'slide-in-from-bottom' },
        '.animate-beam': {
          animation: 'beam-fire 0.4s ease-out forwards',
          transformOrigin: 'left',
        },
        '.animate-beam-reverse': {
          animation: 'beam-fire 0.4s ease-out forwards',
          transformOrigin: 'right',
        },
        '.duration-100': { animationDuration: '100ms' },
        '.duration-200': { animationDuration: '200ms' },
        '.duration-300': { animationDuration: '300ms' },
        '.duration-500': { animationDuration: '500ms' },
        '.duration-700': { animationDuration: '700ms' },
      });
    }),
  ],
};
