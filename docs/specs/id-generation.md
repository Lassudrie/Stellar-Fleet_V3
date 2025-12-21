## IDs de gameplay

- Les identifiants générés par le moteur suivent désormais le format **UUID v4** standard, mais sont produits de manière **strictement déterministe** via `engine/rng.ts` (4 tirages `nextUint32()` par UUID).  
- Les IDs exposés aux appels existants restent au format `prefix_uuid`, aucune source non déterministe (`crypto.randomUUID`, `Date.now`, etc.) n’est autorisée.  
- Les affichages courts doivent utiliser `shortId()` pour éviter d’exposer des UUID complets dans l’UI.
