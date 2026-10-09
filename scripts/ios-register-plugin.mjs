#!/usr/bin/env node
/**
 * После `npx cap sync ios` добавляет наш собственный плагин SimNativeV2Plugin
 * в packageClassList сгенерированного ios/App/App/capacitor.config.json.
 *
 * Зачем: Capacitor CLI пересобирает packageClassList, просканировав ТОЛЬКО
 * node_modules (@capacitor/cli/dist/util/iosplugin.js). Наш плагин лежит в
 * ios/App/App/SimNativeV2Plugin.swift, а не в node_modules, поэтому каждый
 * `cap sync` молча выкидывает его — и на устройстве мост SimNativeV2 не
 * регистрируется, bridge.ts считает платформу браузером.
 *
 * Запуск: node scripts/ios-register-plugin.mjs  (после cap sync ios)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'ios', 'App', 'App', 'capacitor.config.json');
const PLUGIN_CLASS = 'SimNativeV2Plugin';

if (!fs.existsSync(configPath)) {
  console.error(`[ios-register-plugin] не найден ${configPath} — сначала выполните "npx cap sync ios"`);
  process.exit(1);
}

const raw = fs.readFileSync(configPath, 'utf8');
let config;
try {
  config = JSON.parse(raw);
} catch (e) {
  console.error('[ios-register-plugin] не удалось разобрать capacitor.config.json:', e.message);
  process.exit(1);
}

const list = Array.isArray(config.packageClassList) ? config.packageClassList : [];
if (list.includes(PLUGIN_CLASS)) {
  console.log(`[ios-register-plugin] ${PLUGIN_CLASS} уже зарегистрирован`);
  process.exit(0);
}

list.push(PLUGIN_CLASS);
config.packageClassList = list;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log(`[ios-register-plugin] добавлен ${PLUGIN_CLASS} в packageClassList`);
