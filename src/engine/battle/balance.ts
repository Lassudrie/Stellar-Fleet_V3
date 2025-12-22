// Balance profile for Battle System V1.1.
// Centralizes tuning knobs to keep the battle runtime deterministic and testable.

interface TargetingTuning {
  frictionKeepChance: number;
  capitalFocusBomberChance: number;
  transportFocus: {
    base: number;
    perRound: number;
    max: number;
  };
}

interface PacingTuning {
  maxRounds: number;
  etaMissile: number;
  etaTorpedo: number;
  baseAccuracy: number;
  lockGainPerRound: number;
  maxLaunchPerRound: number;
}

interface InterceptionTuning {
  baseChance: number;
}

interface DefenseTuning {
  pdDamagePerPoint: number;
  missileHp: number;
  torpedoHp: number;
}

interface BalanceConfig {
  profile: 'Balance v1.1';
  targeting: TargetingTuning;
  pacing: PacingTuning;
  interception: InterceptionTuning;
  defense: DefenseTuning;
}

export const BALANCE_PROFILE_V11: BalanceConfig = {
  profile: 'Balance v1.1',
  targeting: {
    // 80% chance de conserver la cible si elle reste valide
    frictionKeepChance: 0.6,
    // Faible focus bomber pour les capitals (anti-spam strike craft)
    capitalFocusBomberChance: 0.25,
    // Faible focus transport, croissant avec le round pour éviter les cibles invisibles
    transportFocus: {
      base: 0.05,
      perRound: 0.02,
      max: 0.12
    }
  },
  pacing: {
    // Allonger pour casser les draws persistants
    maxRounds: 10,
    etaMissile: 2,
    etaTorpedo: 3,
    // Hausse marquée pour rendre les tirs cinétiques décisifs
    baseAccuracy: 0.85,
    lockGainPerRound: 0.35,
    maxLaunchPerRound: 3
  },
  interception: {
    // Chance de base d’interception (après la tentative)
    baseChance: 0.15
  },
  defense: {
    // Dégâts PD infligés aux projectiles entrants par point de pdStrength
    // Légère réduction pour rendre les salves plus punitives
    pdDamagePerPoint: 6,
    // Durabilité des missiles et torpilles (inchangée)
    missileHp: 50,
    torpedoHp: 150
  }
};
