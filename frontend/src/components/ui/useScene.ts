import { useEffect } from 'react';

export type Scene = 'theater' | 'app' | 'room';

/**
 * Tell the stylesheet which room we are in. The call screen switches off the
 * film grain and darkens the house lights (see base.css); everything else
 * keeps them.
 */
export function useScene(scene: Scene): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.scene = scene;
    return () => {
      if (root.dataset.scene === scene) delete root.dataset.scene;
    };
  }, [scene]);
}
