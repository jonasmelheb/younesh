<p align="center"><img src="build/icon.png" width="96" alt=""></p>

# Younesh

Un terminal pour Windows où chaque discussion est rangée à gauche, dans des dossiers de couleur.

## Installer sur Windows

1. Ouvre la page **Releases** du dépôt et télécharge :
   - `Younesh-Setup-x.y.z.exe` pour l'installer (raccourci dans le menu Démarrer),
   - ou `Younesh-Portable-x.y.z.exe` pour le lancer sans installation.
2. L'app n'est pas signée, donc Windows affiche « Windows a protégé votre ordinateur ». Clique sur **Informations complémentaires**, puis **Exécuter quand même**.

## Ce que ça fait

- **Discussions à gauche** : chaque terminal est une discussion avec un nom, un dossier de travail et un shell (PowerShell 7, Windows PowerShell, Invite de commandes, Git Bash ou WSL, détectés automatiquement).
- **Dossiers de couleur** : crée des dossiers, choisis leur couleur (palette ou couleur libre), replie-les, renomme-les avec un double-clic. Une discussion peut aussi avoir sa propre couleur.
- **Glisser-déposer** : range une discussion dans un dossier, change l'ordre des discussions ou des dossiers.
- **Discussions Claude Code** : le bouton ✳ Claude lance `claude` dans le dossier choisi. Chaque discussion garde sa propre conversation, qui reprend là où tu t'étais arrêté, même après avoir fermé Younesh.
- **Sandbox** : le bouton ⧉ ouvre une discussion dans ta sandbox. Clic droit pour régler la commande (`{dossier}` est remplacé par le dossier de travail).
- **Commande au démarrage** : par exemple `npm run dev` pour un serveur qui se relance d'un clic.
- **Pastilles** : vert = en cours, bleu = nouvelle activité, rouge = terminé, gris = en veille (démarre au clic).
- Tout est sauvegardé : dossiers, couleurs, ordre et taille de la fenêtre.

## Raccourcis

| Action | Touches |
| --- | --- |
| Nouvelle discussion | Ctrl+Maj+T |
| Nouvelle discussion Claude | Ctrl+Maj+N |
| Nouveau dossier | Ctrl+Maj+D |
| Discussion suivante / précédente | Ctrl+Tab / Ctrl+Maj+Tab |
| Fermer la discussion | Ctrl+Maj+W |
| Renommer | F2 |
| Rechercher | Ctrl+Maj+F |
| Masquer la barre latérale | Ctrl+Maj+B |
| Taille du texte | Ctrl + / Ctrl − / Ctrl 0 |
| Copier / coller | Ctrl+C (avec une sélection) ou Ctrl+Maj+C / Ctrl+V |
| Retour à la ligne dans Claude | Maj+Entrée |

Clic droit sur une discussion ou un dossier pour toutes les options. Clic molette sur une discussion pour la fermer.

## Développer

```bash
npm install
npm start          # lance l'app
npm run dist       # fabrique les .exe (sur Windows)
```

Les `.exe` sont fabriqués automatiquement par GitHub Actions à chaque tag `v*` (par exemple `git tag v1.0.1 && git push --tags`).

Électron, xterm.js et node-pty.

---

<p align="right"><em>Fait par Y</em></p>
