// Build-time data extraction only. The iOS client contains SwiftUI and JSON;
// no JavaScript or Expo runtime is shipped.
import * as tokens from '../../apps/mobile/src/theme/tokens.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const appearance = readFileSync(new URL('../../apps/mobile/src/theme/appearance.ts', import.meta.url), 'utf8');
const map = appearance.match(/export const COLOR_THEME_COLORS:[\s\S]*?= \{([\s\S]*?)\n\}/)[1];
const labels = new Map([...appearance.matchAll(/\{ value: '([^']+)', label: '([^']+)'[^\n]*appearance: '(light|dark)'/g)].map(match => [match[1], { label: match[2], appearance: match[3] }]));
const themes = [...map.matchAll(/\s*(?:'([^']+)'|([\w-]+)):\s*(\w+),/g)].map(match => {
  const id = match[1] || match[2];
  if (!tokens[match[3]] || !labels.has(id)) throw new Error(`Unknown theme ${id}`);
  return { id, ...labels.get(id), colors: tokens[match[3]] };
});
writeFileSync(new URL('../FalconDeckNative/Design/PaletteCatalog.json', import.meta.url), JSON.stringify({ themes }, null, 2) + '\n');
console.log(`Copied ${themes.length} palettes from the existing mobile design tokens.`);
