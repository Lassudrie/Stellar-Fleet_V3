# Vérification manuelle – limites de caméra

1. Lancer le jeu avec `npm run dev` et ouvrir l'aperçu Vite.
2. Depuis la carte, effectuer un panoramique rapide vers chacune des directions (nord, sud, est, ouest).
3. Constater que la caméra ralentit puis s'arrête sur les bords de la zone de jeu : la cible (`target`) et la position de la caméra restent dans la zone des systèmes.
4. Tester le zoom avant/arrière tout en se trouvant près d'un bord : la hauteur suit `minDistance` / `maxDistance` sans traverser les limites horizontales.
5. Revenir vers le centre et vérifier que le panoramique reste fluide à l'intérieur des bornes.
