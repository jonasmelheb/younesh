'use strict';

// Chaque thème donne les couleurs de l'interface (variables CSS) et celles du terminal.
const ANSI_DARK = {
  black: '#1c1f27', red: '#ff6b6b', green: '#4ade80', yellow: '#feca57', blue: '#7c9cff', magenta: '#c084fc', cyan: '#2dd4bf', white: '#d4d7e0',
  brightBlack: '#5b6070', brightRed: '#ff8787', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#a5b8ff', brightMagenta: '#d8b4fe', brightCyan: '#5eead4', brightWhite: '#ffffff',
};

const THEMES = {
  sombre: {
    name: 'Sombre',
    ui: { bg: '#0e0f13', panel: '#15171d', 'panel-2': '#1c1f27', border: '#262a34', 'border-strong': '#333846', 'border-hover': '#3a3f4c', hover: '#222631', 'hover-2': '#2b303d', active: '#252a36', text: '#e6e8ee', muted: '#8b90a0', 'muted-2': '#5b6070', accent: '#7c9cff', 'accent-soft': '#a5b8ff', 'on-accent': '#0b1020', scroll: '#2a2e39' },
    term: { background: '#0e0f13', foreground: '#e6e8ee', cursor: '#e6e8ee', cursorAccent: '#0e0f13', selectionBackground: '#3a4a7a', ...ANSI_DARK },
  },
  minuit: {
    name: 'Minuit',
    ui: { bg: '#0b1020', panel: '#10172b', 'panel-2': '#162036', border: '#1f2a44', 'border-strong': '#2a3756', 'border-hover': '#33426a', hover: '#1a2540', 'hover-2': '#22304f', active: '#1f2d4d', text: '#e3e9f7', muted: '#8792b0', 'muted-2': '#56607e', accent: '#6ea8ff', 'accent-soft': '#9cc3ff', 'on-accent': '#06101f', scroll: '#22304f' },
    term: { background: '#0b1020', foreground: '#e3e9f7', cursor: '#6ea8ff', cursorAccent: '#0b1020', selectionBackground: '#2a3f6e', ...ANSI_DARK, black: '#162036', blue: '#6ea8ff', brightBlue: '#9cc3ff' },
  },
  graphite: {
    name: 'Graphite',
    ui: { bg: '#18181b', panel: '#1f1f23', 'panel-2': '#27272b', border: '#303036', 'border-strong': '#3c3c43', 'border-hover': '#46464e', hover: '#2c2c31', 'hover-2': '#35353b', active: '#323238', text: '#ececef', muted: '#9a9aa3', 'muted-2': '#66666e', accent: '#e8a87c', 'accent-soft': '#f2c4a3', 'on-accent': '#1b120b', scroll: '#35353b' },
    term: { background: '#18181b', foreground: '#ececef', cursor: '#e8a87c', cursorAccent: '#18181b', selectionBackground: '#4a3a30', ...ANSI_DARK, black: '#27272b' },
  },
  clair: {
    name: 'Clair',
    ui: { bg: '#fbfbfc', panel: '#f1f2f5', 'panel-2': '#ffffff', border: '#dfe1e7', 'border-strong': '#cfd2da', 'border-hover': '#bfc3cd', hover: '#e7e9ee', 'hover-2': '#dfe2e9', active: '#dde3f5', text: '#1d2130', muted: '#646a7d', 'muted-2': '#9aa0b0', accent: '#3d63dd', 'accent-soft': '#3d63dd', 'on-accent': '#ffffff', scroll: '#cfd2da' },
    term: {
      background: '#fbfbfc', foreground: '#1d2130', cursor: '#1d2130', cursorAccent: '#fbfbfc', selectionBackground: '#c9d6fb',
      black: '#1d2130', red: '#c4314b', green: '#1f8a4c', yellow: '#9a6700', blue: '#3d63dd', magenta: '#8e44ad', cyan: '#0f7f8a', white: '#c9ccd6',
      brightBlack: '#646a7d', brightRed: '#d9435f', brightGreen: '#2a9d5c', brightYellow: '#b07d00', brightBlue: '#5276e8', brightMagenta: '#a35bc2', brightCyan: '#17909c', brightWhite: '#ffffff',
    },
  },
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// « auto » suit le mode clair ou sombre de Windows.
function themeOf(id) {
  if (THEMES[id]) return THEMES[id];
  return darkQuery.matches ? THEMES.sombre : THEMES.clair;
}
