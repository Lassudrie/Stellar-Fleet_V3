# Vérification manuelle – Bornes de la caméra

1. Lancer le client de développement avec `npm install` (si nécessaire) puis `npm run dev` et ouvrir l'URL Vite indiquée.
2. Charger un scénario existant : la caméra doit démarrer centrée sur le monde d'origine du joueur.
3. Faire un pan soutenu vers chaque bord de la carte : la caméra et son point ciblé cessent de se déplacer avant de sortir du nuage de systèmes.
4. Zoomer/dézoomer jusqu'aux limites configurées : même en hauteur minimale ou maximale, le pan reste fluide mais ne dépasse jamais les bornes.
5. Revenir à l'intérieur de la carte et vérifier que la navigation reste sans accroc (damping actif, aucun saut brusque).

Résultat attendu : impossible de placer la caméra ou le centre de visée en dehors du rectangle borné (marge incluse), tout en conservant une navigation souple.
