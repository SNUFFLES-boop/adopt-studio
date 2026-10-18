# Adopt-Studio

Website for prebuilt VRChat avatars. Everything shown on the site comes from
`shop.json`.

## Easiest way: the Manage page

Open `admin.html` on the website (the **Owner login** link at the bottom of the shop).
Sign in with a fine-grained GitHub token that can only change this repository
(Contents: Read and write). From there you can add avatars with pictures, edit them,
mark them sold or delete them, and change shop settings and terms. Each save commits to
this repository and the website updates in about a minute.

Nobody else can change the shop: the page only works with your token. Never share it.

## Editing by hand

You can also edit `shop.json` on GitHub (open it, click the pencil, then
**Commit changes**). The site updates in about a minute.

## Adding an avatar

1. Upload a picture to the `images` folder (**Add file → Upload files**).
2. In `shop.json`, add an entry to the `avatars` list. Put a comma between entries.

```json
"avatars": [
  {
    "name": "Neon Fox",
    "image": "images/neon-fox.png",
    "category": "Furry",
    "price": 35,
    "priceNote": "incl. Quest version",
    "state": "available",
    "platform": "both",
    "features": ["toggles", "phys bones", "face tracking"],
    "description": "A bright fox with 6 outfit toggles.",
    "link": "https://yourname.gumroad.com/l/neonfox"
  }
]
```

| Field | What it does |
| --- | --- |
| `name` | Avatar name (required) |
| `image` | Picture path, e.g. `images/neon-fox.png`, or a full `https://` link |
| `category` | Groups avatars into filter buttons, e.g. `Anime`, `Furry` |
| `price` | Number only, no currency symbol |
| `priceNote` | Optional small text next to the price |
| `state` | `available`, `reserved` or `sold` |
| `platform` | `pc`, `quest` or `both` |
| `features` | Optional list of short tags |
| `description` | Optional text |
| `link` | Optional store page (Booth, Gumroad, Payhip). Shows a **Buy** button |

Other settings at the top of `shop.json`: `name`, `tagline`, `currency`, `discord`,
`email`, `otherContact`, `payment` and `terms`.

If the site stops loading after an edit, the JSON probably has a missing comma or quote.
Paste it into https://jsonlint.com to find the problem.
