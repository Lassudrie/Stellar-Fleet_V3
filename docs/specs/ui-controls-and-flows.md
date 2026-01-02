# Spécification UI – Contrôles caméra et flux

**Version :** 1.0  
**Statut :** Proposée

---

## 1. Objectifs et portée
- Documenter le comportement attendu de la caméra (pan/zoom, bornes) dans la vue 3D galactique.
- Décrire le flux utilisateur principal : menu → sélection de scénario → session de jeu.
- Encadrer les interactions de sélection (système, flotte) et les ordres disponibles : mouvement, chargement/déchargement, invasion.
- Rappeler les règles de split/merge des flottes et le renvoi vers le test manuel dédié à la caméra.

---

## 2. Contrôles et limites de la caméra
### 2.1 Initialisation
- La caméra se place face au homeworld du joueur et vise son centre (`initialTarget`), avec une hauteur par défaut (~80) et un léger décalage Z pour lire la carte en perspective aplatie (FOV 35°).
- Le `ready` gate empêche toute interaction tant que le scénario n’est pas complètement chargé, évitant les sauts de position.

### 2.2 Pan et zoom
- Pan fluide avec inertie (`dampingFactor 0.05`), verrouillé sur le plan XZ (`screenSpacePanning=false`) pour garder l’horizon stable. Aucune rotation n’est autorisée (`enableRotate=false`).
- Zoom par molette/pinch borné par la taille de la carte : `minDistance ≈ max(mapRadius×0.3, 20)`, `maxDistance ≈ max(mapRadius×2.5, 240)`.

### 2.3 Bornes et clamping
- Les bornes sont dérivées du nuage de systèmes avec une marge minimale de 40 unités (`useMapMetrics`).
- À chaque mouvement (`onChange` du `MapControls`), la position de la caméra **et** la cible sont clampées (`mapBounds.minX/maxX/minZ/maxZ`). Le pan ne peut jamais sortir du rectangle étendu, même à zoom minimum ou maximum.
- Les bornes se recalculent si le nuage de systèmes change (ex. chargement de partie ou génération), garantissant un centrage et des limites cohérents.

### 2.4 Validation
- Suivre le test manuel « Vérification manuelle – Bornes de la caméra » (`docs/manual-camera-bounds.md`) pour attester qu’aucune position ou cible ne sort du périmètre. Ce test doit être relancé après toute modification des contrôles ou des métriques de carte.

---

## 3. Flux principal : menu → scénario → jeu
1. **Menu principal** : affichage plein écran avec deux entrées. « Nouvelle partie » ouvre directement la sélection de scénario ; « Charger » ouvre l’écran de chargement.
2. **Sélection de scénario** :
   - Liste à gauche : choix du template (`SCENARIO_TEMPLATES`), surbrillance du scénario actif, badges Fog of War / AI le cas échéant.
   - Détails à droite : description, paramètres (compte de systèmes, rayon), saisie ou génération d’une seed personnalisée.
   - Action : `Lancer` construit le scénario via `buildScenario(templateId, seed)` puis bascule vers le jeu.
3. **Transition vers la partie** : écran de chargement pendant la génération (`generateWorld`), puis entrée en vue galactique avec caméra centrée et UI de jeu active.

---

## 4. Sélections et inspections
### 4.1 Systèmes stellaires
- Un clic sur un système ouvre le **menu contextuel système** ancré au pointeur et définit la cible courante (`targetSystem`).
- Le menu propose les actions autorisées (détails, sélection de flotte en orbite, move/attack, load/unload, invasion, opérations au sol) selon les règles d’éligibilité ci-dessous.
- Clic sur le fond : fermeture des menus et désélection de flotte.

### 4.2 Flottes
- Clic simple sur une flotte : sélection (`selectedFleetId`), affichage du panneau flotte si disponible.
- Double-clic (ou seconde tape rapide) : inspection détaillée (`SHIP_DETAIL_MODAL`) tout en conservant la sélection.
- Sur smartphone ou écran tactile (pointeur « coarse »), un simple tap ouvre directement l’inspection détaillée afin de réduire la friction.
- La sélection est nettoyée si la flotte disparaît (brouillard ou destruction) pour éviter les références orphelines.

---

## 5. Règles d’émission d’ordres (via menus contextuels/pickers)
### 5.1 Mouvement et attaque
- **Move to** (systèmes neutres/allies) ou **Attack** (systèmes ennemis disposant d’un propriétaire) ouvrent un `FleetPicker` listant les flottes du joueur en orbite ou libres. Sélectionner une flotte émet un `MOVE_FLEET` vers le système cible.
- Les trajectoires sont visibles en 3D (ligne pleine pour le joueur, pointillée pour les autres factions) dès l’ordre validé.

### 5.2 Chargement (Load)
- Disponible si le système cible contient des armées **déployées** du joueur sur des planètes solides.
- Le picker affiche les flottes du joueur en orbite pour `ORDER_LOAD`. En cas d’échec (ex. pas de transport), l’UI affiche l’erreur retournée.

### 5.3 Débarquement (Unload)
- Affiché uniquement dans un système appartenant au joueur, avec planètes solides et armées embarquées dans des flottes du joueur présentes en orbite.
- Le picker déclenche `ORDER_UNLOAD` vers le système cible. Les transports peuvent ensuite déployer via le panneau flotte (voir §6).

### 5.4 Invasion
- Condition : système ennemi possédant au moins une planète solide **et** présence d’une flotte du joueur embarquant une armée (`hasInvadingForce`).
- Action : `Invade` ouvre l’`INVASION_MODAL`, puis `ORDER_INVASION` au système cible. En cas de succès, un log « invasion » est ajouté, sinon l’erreur est remontée à l’UI.

### 5.5 Opérations terrestres
- Lorsque des forces au sol sont détectées, le menu peut exposer `Ground Ops` pour ouvrir le module dédié et déclencher des transferts ou vérifications.

---

## 6. Split, merge et interactions flotte ↔ armées
- **Split** : dans le panneau flotte, sélectionner un sous-ensemble de vaisseaux (hors sélection complète) puis « Split » crée une nouvelle flotte avec ces vaisseaux (`SPLIT_FLEET`). Action réservée aux flottes du joueur.
- **Merge** : si plusieurs flottes du joueur sont en orbite rapprochée du même système, la section « Merge » propose de fusionner dans l’une d’elles (`MERGE_FLEETS`).
- **Déploiement / Embarquement ciblé** :
  - Les `TRANSPORTER` sélectionnés peuvent **déployer** une armée embarquée vers une planète solide du système (menu déroulant si plusieurs planètes) via `UNLOAD_ARMY`.
  - Un transport vide peut **embarquer** une armée déployée du joueur présente sur ces planètes via `LOAD_ARMY`.
- Les listes sont filtrées par faction : aucune action de split/merge ou d’embarquement n’est proposée sur des flottes ennemies.

---

## 7. Référence de test manuel
- Exécuter systématiquement le test décrit dans `docs/manual-camera-bounds.md` après toute modification affectant la caméra (damping, bornes, métriques de carte, navigation). Il constitue la validation manuelle obligatoire pour cette spécification.
