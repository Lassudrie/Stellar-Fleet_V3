# Spécification : Territoire et bordures

## Objectif
Cette page décrit comment le moteur calcule l'appartenance territoriale à partir des systèmes stellaires, comment cette information est projetée dans l'interface (`components/TerritoryBorders.tsx`) et en quoi elle se distingue des mécaniques de gameplay qui s'appuient directement sur les champs `ownerFactionId` des systèmes et des planètes.

## Paramètres clefs
- **Rayon d'influence** : `TERRITORY_RADIUS = 28` (dans `data/static.ts`). Ce rayon fixe la portée maximale d'un système pour revendiquer de l'espace autour de lui.

## Calcul du territoire (moteur)
La fonction `engine/territory.ts#getTerritoryOwner` détermine l'ID de faction qui contrôle un point 3D (`Vec3`), ou `null` si l'espace est neutre.

Étapes :
1. **Filtrer** les systèmes sans propriétaire (`ownerFactionId === null`). Seuls les systèmes contrôlés projettent une influence.
2. **Trier** les systèmes restants par `id` pour garder un comportement déterministe en cas d'égalité de distance.
3. **Identifier le système le plus proche** du point cible en comparant les distances au carré (`distSq`).
4. **Détecter les égalités** : si deux systèmes de factions différentes sont exactement à la même distance minimale, l'espace est contesté et donc **neutre** (`null`).
5. **Vérifier la portée** : si la distance minimale dépasse `TERRITORY_RADIUS`, le point est trop éloigné et reste neutre.
6. **Retourner la faction** du système le plus proche si aucune condition de neutralité n'a été rencontrée.

Conséquences :
- Un rayon fixe tronque les cellules de Voronoï ; au-delà, l'espace reste libre.
- Les égalités de distance entre factions différentes rendent la zone neutre (aucun vainqueur implicite).
- La logique moteur ne tient pas compte de la présence de planètes ou d'autres entités : seule la position des systèmes et leur propriétaire importe.

## Représentation UI des frontières
Le composant `components/TerritoryBorders.tsx` applique un algorithme visuel dérivé de la logique précédente pour dessiner des polygones par faction :

1. **Échantillonnage initial** : chaque système contrôlé génère un disque discretisé (`CIRCLE_SEGMENTS = 64`) de rayon `TERRITORY_RADIUS` autour de sa position (plan XZ).
2. **Découpage par médiatrices** : pour chaque autre système suffisamment proche, le disque est coupé par le plan médian (principe de Voronoï) afin de conserver uniquement la partie la plus proche du système courant.
3. **Nettoyage** : les polygones sont simplifiés pour éliminer les points quasi dupliqués et fermer proprement les contours.
4. **Fusion des segments** : les arêtes situées sur une médiatrice commune sont fusionnées ; si les deux systèmes partagent la même faction, la bordure est supprimée, sinon elle reste dessinée comme frontière inter-factions.
5. **Assemblage par faction** : les systèmes d'une même faction sont regroupés pour produire des surfaces opaques (remplissage légèrement teinté) et des segments de contour plus clairs. Le prop `signature` force un recalcul uniquement lorsque la possession des systèmes change.

Points d'attention UI :
- Les bordures n'apparaissent que pour les systèmes ayant un `ownerFactionId` défini ; un système neutre n'engendre aucune surface.
- Le rendu est purement visuel : il ne modifie pas la logique de capture ou de déplacement.

## Distinction avec le gameplay
- Les systèmes et planètes possèdent leur propre `ownerFactionId` (`types.ts`), utilisé par les mécaniques de capture, d'économie ou d'invasion. Le territoire visuel n'écrase pas ces valeurs.
- Une planète peut appartenir à une faction différente de la zone où elle se trouve visuellement si la logique de gameplay l'autorise ; la superposition sert uniquement d'indication spatiale.
- Les zones neutres (au-delà du rayon ou en cas d'égalité parfaite) apparaissent sans couleur et n'accordent aucun droit particulier en gameplay.
