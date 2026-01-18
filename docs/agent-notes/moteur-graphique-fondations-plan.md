# Plan d'action - fondations du moteur graphique multi-echelle

## Objectif
Mettre en place un rendu multi-echelle sans couture, spatialement coherent, du niveau galaxie jusqu'a la surface, avec transitions cross-fade, streaming deterministe et controles camera stables.

## Schema robuste (multi-echelle, coherent spatialement)

### A. Galaxie -> Systeme
- A grande distance, un systeme est rendu comme un point/halo (impostor).
- En approchant, afficher etoile et orbites sous forme d'elements simples.
- Transition par cross-fade base sur le screen-space radius du systeme (seuil en pixels).
- Le repere actif et le niveau de rendu changent, mais la trajectoire camera reste continue (pas de teleport).

### B. Systeme -> Planete (echelle reelle)
- Planete lointaine: sphere low-poly + shader simple.
- En approche: augmenter la fidelite (normales, detail procedural, overlay).
- Si surface jouable: activer repere planete/surface + overlay cellulaire ou patches locaux.
- Declencheur stable: taille apparente en pixels, distance camera/rayon planete, ou combinaison avec hysteresis.

### C. Pas de "pop": streaming + cache + hysteresis
- Precharge: demarrer le chargement/generation du niveau suivant avant le seuil.
- Hysteresis: seuil d'entree different du seuil de sortie (ex: entrer 200 px, sortir 150 px).
- Cross-fade: melange des representations pendant 0.3-1.0 s de zoom.

## Camera "echelle reelle": zoom, vitesse, clamp

### A. Zoom exponentiel
- Controler le zoom via logDistance.
- Input (scroll/pinch) ajoute un delta a logDistance.
- Distance reelle = exp(logDistance) ou 2^logDistance.

### B. Vitesse adaptative
- Vitesse de pan/translation proportionnelle a la distance courante.

### C. Clamping intelligent
- Distance minimale > rayon planete + marge (eviter traverser la planete).
- Distance maximale plafonnee au niveau galaxie.

## Donnees a l'echelle: unites et conversions
- Simulation: unites SI (m, s), double precision, hierarchie de reperes.
- Rendu: unites locales stables (ex: 1 unit = 1 m en repere planete, 1 unit = 1 km en repere systeme).
- Conversions centralisees et deterministes entre reperes.
- Un meme objet peut etre rendu dans des unites differentes selon le repere actif, sans rupture spatiale.

## Rendu d'unites par milliers (aggregation + continuite)

### A. Aggregation obligatoire
- Galaxie: 1 point = 1 flotte.
- Systeme: 1 point = 1 escadre/groupe tactique.
- Proche: unites individuelles instanciees.

### B. Continuite spatiale
- Le point d'agregat et les unites individuelles partagent la meme position barycentrique.
- Transition sans couture via cross-fade: garder le point visible pendant l'apparition des unites.

## Checklist d'implementation (socle technique)

### A. Module "Reference Frames"
- Types: FrameId, parentId, transform (position/rotation), scale (optionnel).
- Fonctions: worldToFrame, frameToWorld, compose, invert.
- Positions en double precision.

### B. Floating Origin Manager
- Suit la camera.
- Calcule un offset global.
- Applique l'offset aux objets rendus (ou a un root node).

### C. Multi-pass Renderer
- 2-3 scenes ou couches de rendu.
- near/far par pass.
- Ordre de rendu controle.

### D. Zoom Controller exponentiel
- logDistance + mapping input -> delta.
- Vitesse de pan proportionnelle a distance.
- Clamps min/max.

### E. LOD + Cross-fade + Hysteresis
- Declencheurs screen-space.
- Prechargement du niveau suivant.
- Fondu de materiaux/alpha sur une fenetre de temps.

### F. Streaming deterministe
- Seed derivee: galaxySeed -> systemSeed -> planetSeed -> tileSeed.
- Cache des resultats + invalidation claire.
- Jobs de generation budgetes par frame.

## Ce que "sans couture" exclut
- Un seul frustum near=0.1 far=1e18 (z-fighting).
- Une seule scene en coordonnees galactiques en float32 (jitter).
- Une surface planetaire detaillee partout en permanence (impossible mobile).

## Notes de validation
- Verifier transitions (galaxie->systeme, systeme->planete, surface) sans pop.
- Mesurer stabilite camera (zoom exponentiel, pan proportionnel).
- Confirmer coherence spatiale des agregats et unites individuelles.
