import React from 'react';
import { PerspectiveCamera, MapControls } from '@react-three/drei';

const GameCamera: React.FC = React.memo(() => {
  return (
    <>
      {/* 
        PerspectiveCamera:
        - position: [0, 80, 50] donne un angle élevé (quasi top-down mais avec de la profondeur).
        - fov: 35 pour aplatir légèrement la perspective (effet isométrique).
      */}
      <PerspectiveCamera makeDefault position={[0, 80, 50]} fov={35} />
      
      {/* 
        MapControls:
        - Idéal pour les RTS/Cartes.
        - enableRotate={false} : Verrouille la rotation (pas de pivot).
        - screenSpacePanning={false} : Le pan suit le sol (plan XZ), pas l'écran.
        - dampingFactor : Ajoute de l'inertie fluide.
      */}
      <MapControls 
        target={[0, 0, 0]}
        enableRotate={false}
        enablePan={true}
        enableZoom={true}
        minDistance={20}
        maxDistance={250}
        dampingFactor={0.05}
        screenSpacePanning={false}
      />
    </>
  );
});

export default GameCamera;