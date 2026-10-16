// Package the Tauri-built app without Finder automation, including on CI.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if (process.platform !== 'darwin') throw Error('Build the macOS package on macOS');
const bundle = resolve(process.argv[2] || 'src-tauri/target/release/bundle');
const app = join(bundle, 'macos', 'Nook.app');
if (!existsSync(app)) throw Error('Build the Tauri app bundle first');
mkdirSync(join(bundle, 'dmg'), {recursive:true});
const stage = mkdtempSync(join(tmpdir(), 'nook-dmg-'));
const output = join(bundle, 'dmg', 'Nook_0.1.0_aarch64.dmg');
try {
 cpSync(app, join(stage, 'Nook.app'), {recursive:true, dereference:false});
 symlinkSync('/Applications', join(stage, 'Applications'));
 execFileSync('hdiutil', ['create', '-volname', 'Nook', '-srcfolder', stage, '-format', 'UDZO', '-ov', output], {stdio:'inherit'});
 execFileSync('hdiutil', ['verify', output], {stdio:'inherit'});
 console.log(output);
} finally { rmSync(stage, {recursive:true,force:true}); }
