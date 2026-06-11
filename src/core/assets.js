import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const textureLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

// Loads a GLB and resolves to the raw gltf result ({ scene, animations }).
// Callers clone (SkeletonUtils for skinned rigs) — the cache means each
// file is fetched/parsed once no matter how many instances spawn.
// Rest-pose bounding box of a (possibly skinned) rig. Box3.setFromObject is
// a TRAP for SkinnedMesh: it measures SKINNED vertex positions, which depend
// on whether the skeleton has been updated by a render yet — measured at
// load time it can return garbage (inverse-bind-scattered verts, ~90x too
// big). The raw position attribute IS the bind pose, so measure that.
export function measureRestBox(root, out = new THREE.Box3()) {
  out.makeEmpty();
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    out.union(box);
  });
  return out;
}

const gltfCache = new Map();
export function loadGLB(url) {
  if (!gltfCache.has(url)) {
    gltfCache.set(
      url,
      new Promise((resolve, reject) => gltfLoader.load(url, resolve, undefined, reject))
    );
  }
  return gltfCache.get(url);
}

export function loadTexture(url, renderer) {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        if (renderer) {
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        }
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}
