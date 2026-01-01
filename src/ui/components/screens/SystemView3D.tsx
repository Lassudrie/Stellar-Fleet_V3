import React, { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { StarSystem, StarSystemAstro } from '../../../shared/types';

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
}

const SystemView3D: React.FC<SystemView3DProps> = ({ starSystem, astro }) => {
  const planetRadii = useMemo(() => {
      const count = (astro?.planets?.length ?? starSystem.planets.length) || 3;
      return Array.from({ length: count }, (_, idx) => 2.4 + idx * 1.3);
  }, [astro?.planets?.length, starSystem.planets.length]);

  const primaryColor = starSystem.color || '#7dd3fc';

  return (
    <div className="w-full h-full bg-black">
      <Canvas camera={{ position: [0, 6, 12], fov: 55 }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={0.6} />
        <pointLight position={[6, 6, 4]} intensity={1.5} />

        <mesh>
          <sphereGeometry args={[1.8, 48, 48]} />
          <meshStandardMaterial
            color={primaryColor}
            emissive={primaryColor}
            emissiveIntensity={0.8}
            roughness={0.4}
            metalness={0.1}
          />
        </mesh>

        <group>
          {planetRadii.map((radius, index) => (
            <group key={`placeholder-planet-${index}`}>
              <mesh position={[radius, 0, 0]}>
                <sphereGeometry args={[0.35 + index * 0.05, 32, 32]} />
                <meshStandardMaterial color="#cbd5e1" roughness={0.6} metalness={0.2} />
              </mesh>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <torusGeometry args={[radius, 0.005, 8, 128]} />
                <meshBasicMaterial color="#334155" />
              </mesh>
            </group>
          ))}
        </group>
      </Canvas>
    </div>
  );
};

export default SystemView3D;
