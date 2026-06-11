// Dev-only: sniff GLB JSON chunks — animations, meshes, tri counts.
// Usage: node scripts/inspect-glb.mjs
import { readFileSync, readdirSync } from 'fs';

const dir = 'public/models';
for (const f of readdirSync(dir).filter((f) => f.endsWith('.glb')).sort()) {
  const buf = readFileSync(`${dir}/${f}`);
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    console.log(`${f}: NOT A GLB`);
    continue;
  }
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  let tris = 0;
  for (const m of json.meshes ?? [])
    for (const p of m.primitives ?? []) {
      const acc = json.accessors?.[p.indices];
      if (acc) tris += acc.count / 3;
    }
  const anims = (json.animations ?? []).map((a) => a.name);
  const skinned = (json.skins ?? []).length > 0;
  console.log(
    `${f}  tris=${Math.round(tris)}  skins=${skinned ? 'yes' : 'no'}  anims=[${anims.join(', ')}]`
  );
}
