import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

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
