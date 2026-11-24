import { useEffect, useState } from 'react';
import type { Priority } from '../../core/types';
import { DEFAULT_CUSTOM_TEMPLATE, DEFAULT_OPTIONS, type CompileOptions } from '../../core/compile/compile';
import { kvGet, kvSet } from './db';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  macros: string[];
  defaultPriority: Priority;
  compile: CompileOptions;
  customTemplate: string;
  tocOpen: boolean;
  panelOpen: boolean;
}

export const DEFAULT_MACROS = [
  'Cut fluff by 50%',
  'Add a concrete example',
  'Keep the original formatting',
  'Cite a source',
  'Make it more specific',
  'Use simpler words',
];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  macros: DEFAULT_MACROS,
  defaultPriority: 'suggestion',
  compile: DEFAULT_OPTIONS,
  customTemplate: DEFAULT_CUSTOM_TEMPLATE,
  tocOpen: true,
  panelOpen: true,
};

const KEY = 'settings';
const listeners = new Set<(s: Settings) => void>();
let current: Settings = DEFAULT_SETTINGS;
let loaded: Promise<Settings> | null = null;

export function loadSettings(): Promise<Settings> {
  loaded ??= kvGet<Partial<Settings>>(KEY, {}).then((s) => {
    current = { ...DEFAULT_SETTINGS, ...s, compile: { ...DEFAULT_OPTIONS, ...(s.compile ?? {}) } };
    listeners.forEach((l) => l(current));
    return current;
  });
  return loaded;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  listeners.forEach((l) => l(current));
  void kvSet(KEY, current);
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void, boolean] {
  const [s, setS] = useState(current);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    listeners.add(setS);
    void loadSettings().then((v) => {
      setS(v);
      setReady(true);
    });
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return [s, updateSettings, ready];
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function isDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
