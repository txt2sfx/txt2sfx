/**
 * The drawn icons, in one place.
 *
 * ## Why a module rather than a glyph per button
 *
 * Every one of these used to be a character in a string — `▶`, `★`, `⤓`, `↻`, `✕`. That is
 * the cheapest possible icon and it is wrong for the same reason `LanguageMenu`'s globe and
 * `PromptRow`'s gear were already drawn by hand: a glyph is rendered by whichever font on
 * the reader's machine happens to claim it, so the play triangle is a thin outline on one
 * platform and a filled emoji on the next, `⤓` is missing entirely on several, and the pair
 * that has to look like one control — the star on a card and the same star in the studio —
 * came out at two different weights because they sat in two different font stacks.
 *
 * These are one set, supplied as artwork, so the coordinates are kept **exactly as given**:
 * the 2000-unit box, the `matrix(.1 0 0 -.1 0 2000)` flip and all. Re-deriving them at 16
 * units to make the numbers prettier would be redrawing somebody's icon by hand, and the
 * six files that import this would then each be a slightly different redrawing.
 *
 * They are outlines rather than solids, which is the one thing to know before adding a
 * ninth: a new icon that is filled will not sit in this set, however good it looks alone.
 *
 * ## Two of them are not in the set
 *
 * {@link IconPause} and {@link IconStop} are drawn here to match, because they only ever
 * appear as the other half of a toggle — a `▶` that becomes a text `❚❚` changes size under
 * the cursor mid-press, which is worse than either shape being slightly off. They are two
 * rounded bars and one rounded square at the same stroke weight as the artwork, and nothing
 * else in this file is hand-drawn.
 *
 * ## Sizing
 *
 * `size` is a pixel number, not a class, because half of these sit in fixed-width flex
 * slots (`.rail-play` is 13 px wide) and half in text buttons — `font-size` cannot reach an
 * SVG, so the number has to be at the call site. `.ic` in `styles.css` carries the two
 * things that never vary: `currentColor`, so an icon follows its button's own hover, focus
 * and amber-when-on states for free, and the baseline nudge that makes `<IconStar /> Star`
 * read as one line rather than as an icon standing on a word.
 *
 * @packageDocumentation
 */

/** What every icon here takes. `size` is both width and height — all eight are square. */
export interface IconProps {
  /** Edge length in CSS pixels. Defaults to 14, which is the size in the header. */
  readonly size?: number;
  /** Extra classes, appended after `ic`. Rarely needed; a hue belongs on the button. */
  readonly className?: string;
}

/** The artwork's own frame: a 2000-unit box, y-flipped, filled rather than stroked. */
function Art({ size = 14, className = '', children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className={`ic${className === '' ? '' : ` ${className}`}`}
      viewBox="0 0 2000 2000"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="matrix(.1 0 0 -.1 0 2000)" fill="currentColor" stroke="none">
        {children}
      </g>
    </svg>
  );
}

/**
 * The star, outlined and solid from one drawing.
 *
 * The artwork is a ring — an outer star and an inner star wound the other way, so the
 * middle is a hole. Dropping the second contour fills it. That is why `on` is not a second
 * icon: a favourite and a not-favourite have to be the *same* star at the same weight in
 * the same place, and two files would drift apart the first time one of them was nudged.
 */
const STAR_OUTLINE =
  'M9880 19599 c-470 -33 -914 -311 -1158 -724 -22 -38 -559 -1116 -1192 -2395 -633 -1279 -1155 -2329 -1159 -2333 -4 -4 -1146 -176 -2537 -382 -1391 -205 -2568 -381 -2616 -389 -294 -55 -533 -178 -755 -389 -127 -122 -214 -236 -286 -376 -228 -440 -233 -927 -15 -1365 113 -227 58 -170 2038 -2079 1004 -968 1852 -1786 1884 -1817 l59 -58 -441 -2584 c-243 -1421 -446 -2633 -451 -2693 -44 -557 240 -1101 728 -1394 251 -151 530 -220 841 -208 214 8 398 56 591 153 52 25 1098 577 2326 1225 1663 879 2240 1179 2264 1179 25 0 602 -301 2269 -1182 1229 -651 2278 -1203 2330 -1229 224 -110 439 -155 695 -146 283 9 497 69 719 201 487 289 775 836 735 1395 -5 66 -184 1128 -449 2659 -242 1401 -440 2553 -440 2558 0 6 673 678 1496 1495 2372 2352 2263 2243 2333 2344 72 103 157 274 194 390 123 381 96 758 -78 1120 -194 403 -594 715 -1025 799 -47 9 -1223 185 -2614 391 -1391 206 -2533 378 -2537 382 -4 4 -530 1063 -1169 2352 -782 1579 -1181 2375 -1224 2440 -126 191 -284 340 -480 456 -271 158 -561 226 -876 204z';

/** The hole. Appended to {@link STAR_OUTLINE} it is a ring; alone it means nothing. */
const STAR_HOLE =
  'm165 -1453 c9 -13 536 -1073 1171 -2355 635 -1282 1173 -2361 1196 -2399 199 -325 563 -581 928 -651 30 -6 1196 -180 2590 -386 1394 -206 2545 -377 2558 -380 28 -7 49 -48 36 -73 -5 -11 -657 -662 -1449 -1447 -2131 -2114 -2294 -2278 -2364 -2374 -206 -285 -312 -680 -272 -1011 10 -82 136 -813 776 -4520 58 -333 105 -621 105 -640 0 -42 -24 -70 -61 -70 -18 0 -850 435 -2281 1192 -1239 655 -2285 1206 -2325 1224 -318 149 -690 182 -1038 94 -61 -15 -153 -45 -205 -67 -52 -21 -1118 -580 -2367 -1241 -1479 -782 -2283 -1202 -2301 -1202 -38 0 -66 32 -65 73 1 18 85 518 187 1112 426 2485 686 4016 697 4100 40 305 -52 681 -234 957 -82 125 -152 199 -527 561 -1327 1277 -3182 3067 -3268 3152 -56 56 -102 109 -102 117 0 9 8 25 17 37 16 19 245 54 2618 406 1430 211 2625 391 2656 399 339 89 650 310 840 594 28 42 160 298 294 567 1580 3193 2093 4226 2107 4243 18 21 66 14 83 -12z';

export interface StarProps extends IconProps {
  /** Filled rather than outlined — this sound is a favourite, this repository is starred. */
  readonly on?: boolean;
}

/** Favourites, here and on GitHub. Solid when `on`, the same outline when it is not. */
export function IconStar({ on = false, ...rest }: StarProps): React.JSX.Element {
  return (
    <Art {...rest}>
      <path d={on ? STAR_OUTLINE : `${STAR_OUTLINE} ${STAR_HOLE}`} />
    </Art>
  );
}

/**
 * The four-pointed star: *a model wrote this*.
 *
 * Deliberately a different shape from {@link IconStar} rather than a different colour of
 * it. One marks what the user kept and the other marks what a model will make, and the two
 * sit four inches apart on the studio screen — a distinction carried by hue alone would be
 * no distinction at all for the readers who need it most.
 */
export function IconSpark(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M9885 19994 c-16 -2 -68 -9 -115 -15 -274 -37 -561 -183 -775 -394 -115 -114 -200 -233 -275 -390 -27 -55 -513 -1378 -1080 -2940 -568 -1562 -1037 -2845 -1043 -2851 -7 -6 -1290 -476 -2852 -1044 -1562 -567 -2885 -1053 -2940 -1080 -421 -203 -708 -585 -786 -1050 -19 -106 -16 -374 4 -483 53 -290 189 -550 395 -755 115 -115 233 -198 387 -272 55 -27 1378 -513 2940 -1080 1562 -568 2845 -1038 2852 -1044 6 -6 475 -1289 1043 -2851 567 -1562 1053 -2885 1080 -2940 200 -415 571 -698 1027 -782 119 -22 387 -22 506 0 291 54 550 189 755 395 115 115 198 233 272 387 27 55 513 1378 1080 2940 568 1562 1038 2845 1044 2851 6 6 1289 475 2851 1043 1562 567 2885 1053 2940 1080 298 144 521 366 665 665 96 199 133 371 133 615 0 244 -37 416 -133 615 -144 299 -367 521 -665 665 -55 27 -1378 513 -2940 1080 -1562 568 -2845 1037 -2851 1043 -6 7 -476 1290 -1044 2852 -567 1562 -1053 2885 -1080 2940 -199 413 -577 702 -1021 780 -84 15 -317 27 -374 19z m1204 -4427 c597 -1640 1099 -3012 1117 -3048 63 -127 169 -237 295 -304 34 -18 1409 -523 3055 -1121 1646 -599 2994 -1091 2994 -1094 0 -3 -1348 -495 -2994 -1094 -1646 -598 -3021 -1103 -3055 -1121 -122 -65 -231 -176 -291 -296 -22 -43 -1633 -4453 -2128 -5826 -43 -117 -79 -213 -82 -213 -3 0 -495 1347 -1094 2994 -598 1646 -1103 3021 -1121 3055 -71 132 -182 237 -320 302 -44 20 -1415 522 -3047 1115 -1632 594 -2968 1081 -2968 1084 0 3 1336 490 2968 1084 1632 593 3003 1095 3047 1115 138 65 249 170 320 302 18 34 523 1409 1121 3055 599 1646 1091 2994 1094 2994 3 0 493 -1342 1089 -2983z" />
    </Art>
  );
}

/** Play. The one control every list in this application repeats on every row. */
export function IconPlay(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M4155 19279 c-222 -11 -413 -47 -615 -118 -161 -56 -203 -75 -385 -170 -410 -215 -684 -474 -916 -866 -138 -234 -229 -489 -276 -770 -17 -106 -18 -390 -18 -7355 0 -6982 1 -7249 18 -7355 46 -274 135 -528 267 -756 224 -389 513 -664 927 -882 393 -207 709 -287 1128 -287 397 0 725 76 1060 247 61 31 812 490 1670 1021 2357 1458 2706 1674 5880 3637 4097 2534 3972 2457 4050 2500 526 290 928 823 1059 1405 41 180 51 275 51 495 0 214 -10 316 -46 480 -81 367 -295 761 -573 1053 -105 111 -355 300 -476 362 -53 27 -10 0 -1980 1210 -525 322 -2757 1692 -3757 2307 -398 243 -1050 644 -1450 890 -1235 757 -1680 1030 -3528 2165 -777 476 -936 568 -1085 626 -334 130 -635 178 -1005 161z m231 -1429 c97 -10 229 -47 305 -85 25 -13 421 -254 880 -536 459 -281 1030 -632 1269 -779 885 -543 2745 -1685 3730 -2290 2088 -1282 3953 -2427 4871 -2990 382 -235 733 -449 780 -475 125 -71 195 -129 258 -214 66 -90 104 -170 133 -282 29 -115 22 -289 -15 -404 -56 -172 -190 -332 -353 -424 -43 -25 -389 -237 -769 -471 -1261 -780 -4462 -2760 -7615 -4710 -1714 -1060 -3138 -1939 -3165 -1953 -196 -98 -462 -118 -679 -50 -99 31 -248 107 -338 173 -123 90 -239 259 -285 415 -17 57 -18 376 -21 7195 -2 7771 -6 7196 52 7338 27 68 96 178 147 237 122 139 410 283 609 304 106 12 105 12 206 1z" />
    </Art>
  );
}

/**
 * Pause, drawn to match — see the header on why this one is not from the set.
 *
 * Stroked rather than filled because everything beside it is an outline, and at 230 units
 * on the 2000-unit box the two bars carry the same visual weight as the play triangle they
 * replace. Not the flipped frame: there is nothing to keep faithful here.
 */
export function IconPause({ size = 14, className = '' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={`ic${className === '' ? '' : ` ${className}`}`}
      viewBox="0 0 2000 2000"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="230" strokeLinejoin="round">
        <rect x="330" y="200" width="460" height="1600" rx="230" />
        <rect x="1210" y="200" width="460" height="1600" rx="230" />
      </g>
    </svg>
  );
}

/** Stop. The same argument as {@link IconPause}: it is only ever play's other half. */
export function IconStop({ size = 14, className = '' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={`ic${className === '' ? '' : ` ${className}`}`}
      viewBox="0 0 2000 2000"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="230"
        y="230"
        width="1540"
        height="1540"
        rx="320"
        fill="none"
        stroke="currentColor"
        strokeWidth="230"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Download, and install — both are "the bytes come down to this machine". */
export function IconDownload(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M9859 19985 c-264 -53 -483 -260 -549 -521 -20 -76 -20 -144 -20 -6406 0 -3480 -3 -6328 -7 -6328 -5 0 -1520 1511 -3368 3358 -3153 3152 -3364 3361 -3430 3394 -128 66 -203 83 -350 82 -114 0 -140 -4 -210 -28 -223 -76 -386 -240 -461 -461 -23 -70 -27 -97 -28 -210 -1 -147 16 -222 82 -350 33 -66 279 -314 4021 -4060 2192 -2194 4008 -4007 4036 -4028 239 -187 611 -187 850 0 28 21 1844 1834 4036 4028 3745 3749 3988 3994 4021 4060 128 250 114 519 -37 744 -87 129 -213 224 -370 277 -70 23 -97 27 -210 28 -110 1 -141 -3 -205 -22 -156 -49 -196 -78 -435 -312 -122 -118 -1636 -1629 -3365 -3358 l-3145 -3142 -5 6352 c-5 6163 -6 6355 -24 6408 -122 361 -466 567 -827 495z" />
      <path d="M2028 1420 c-225 -38 -426 -190 -527 -395 -55 -113 -66 -167 -66 -315 1 -121 4 -143 29 -215 81 -234 252 -399 491 -471 58 -18 337 -19 8010 -22 7176 -2 7958 -1 8030 13 44 9 117 34 163 55 188 90 309 225 378 425 25 72 28 94 29 215 0 104 -4 149 -18 194 -75 243 -245 415 -492 498 l-70 23 -7955 1 c-4375 1 -7976 -2 -8002 -6z" />
    </Art>
  );
}

/**
 * Discard.
 *
 * Replaces a `✕`, which was the wrong sign in the two places it was used: a cross is
 * *close this*, and the button beside it in `BridgeDialog` still is. Forgetting a render
 * and discarding a proposed lane both destroy something, and a bin says so before the
 * press rather than after.
 */
export function IconTrash(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M9820 19994 c-771 -41 -1474 -260 -2101 -654 -449 -283 -887 -694 -1195 -1120 -194 -269 -409 -670 -527 -980 -169 -449 -277 -990 -277 -1396 l0 -122 -2188 -6 c-2103 -6 -2190 -7 -2269 -25 -239 -56 -425 -225 -510 -463 -34 -97 -44 -290 -19 -387 64 -249 232 -435 467 -517 l84 -29 788 -3 787 -3 0 -6147 c0 -5316 2 -6163 15 -6258 54 -414 220 -799 476 -1105 202 -240 430 -420 704 -555 243 -120 512 -194 774 -214 187 -14 10155 -14 10342 0 171 13 342 48 511 105 780 263 1334 941 1443 1769 13 95 15 942 15 6258 l0 6148 763 0 c732 0 767 1 842 20 237 61 419 228 502 462 34 97 44 290 19 387 -71 277 -271 476 -539 535 -51 11 -366 15 -1712 20 -907 3 -1894 6 -2192 6 l-543 0 0 123 c0 408 -107 947 -277 1397 -73 192 -261 573 -361 732 -406 643 -955 1159 -1606 1510 -492 266 -1060 441 -1596 493 -149 14 -505 25 -620 19z m474 -1439 c868 -91 1639 -566 2110 -1300 182 -283 329 -644 396 -971 22 -107 45 -302 55 -461 l6 -103 -2861 0 -2861 0 6 103 c19 316 58 527 146 792 102 305 269 616 463 864 107 137 322 354 456 462 418 337 945 555 1481 613 170 19 431 19 603 1z m5423 -10397 l-2 -6123 -22 -74 c-31 -106 -74 -187 -141 -266 -110 -132 -229 -208 -385 -245 -81 -20 -140 -20 -5167 -20 -5027 0 -5086 0 -5167 20 -156 37 -275 113 -385 245 -67 79 -110 160 -141 266 l-22 74 -2 6123 -3 6122 5720 0 5720 0 -3 -6122z" />
      <path d="M7778 11420 c-294 -35 -526 -234 -610 -525 l-23 -80 0 -2960 c0 -3340 -9 -3001 81 -3184 133 -269 441 -428 735 -379 163 27 280 85 390 193 75 73 111 124 154 218 71 153 66 -92 63 3187 l-3 2955 -23 70 c-114 337 -427 544 -764 505z" />
      <path d="M12060 11419 c-274 -29 -508 -225 -602 -504 l-23 -70 -3 -2955 c-3 -3317 -9 -3036 73 -3205 71 -146 179 -256 320 -326 286 -140 600 -87 826 141 61 61 86 96 123 171 90 183 81 -156 81 3184 l0 2960 -23 80 c-101 348 -416 562 -772 524z" />
    </Art>
  );
}

/** Round again: loop the playback, or ask for another take of the same lane. */
export function IconRotate(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M1285 19985 c-243 -53 -448 -232 -528 -464 -39 -111 -49 -278 -23 -393 58 -258 240 -447 521 -536 45 -15 234 -17 1818 -22 l1768 -5 -68 -40 c-202 -118 -653 -432 -938 -654 -502 -390 -1070 -939 -1491 -1441 -427 -507 -855 -1136 -1150 -1690 -688 -1290 -1067 -2612 -1170 -4080 -23 -326 -23 -1011 0 -1325 48 -656 131 -1188 275 -1760 392 -1562 1133 -2971 2200 -4185 190 -216 660 -686 881 -881 1219 -1076 2630 -1819 4210 -2214 790 -198 1541 -288 2410 -288 584 0 1042 34 1574 118 1859 292 3603 1114 5036 2374 216 190 686 660 881 881 1073 1215 1817 2627 2210 4195 201 800 291 1546 292 2420 1 436 -7 605 -44 990 -191 1984 -988 3887 -2266 5411 -855 1020 -1796 1787 -2974 2424 -905 489 -1920 841 -2959 1025 -258 46 -317 51 -421 35 -285 -41 -519 -250 -589 -526 -25 -96 -27 -251 -4 -343 48 -200 189 -378 370 -469 91 -45 141 -58 384 -101 2135 -374 4038 -1542 5361 -3291 606 -801 1052 -1681 1358 -2680 176 -573 298 -1241 343 -1880 17 -240 17 -940 0 -1170 -68 -923 -258 -1765 -580 -2570 -458 -1146 -1077 -2080 -1948 -2941 -489 -484 -985 -877 -1524 -1207 -980 -600 -2039 -991 -3175 -1171 -437 -69 -805 -96 -1325 -96 -765 0 -1333 68 -2082 249 -1047 253 -2149 774 -3023 1430 -572 429 -1113 947 -1551 1486 -559 687 -976 1400 -1316 2250 -322 806 -512 1644 -580 2570 -17 224 -17 939 0 1165 65 880 249 1710 560 2520 187 489 499 1099 789 1543 585 896 1309 1659 2173 2292 217 159 713 480 742 480 4 0 8 -728 8 -1618 0 -1568 1 -1621 19 -1694 66 -256 267 -453 532 -519 85 -21 249 -17 344 10 207 58 361 188 456 386 74 152 69 -65 69 2806 0 2530 0 2587 -19 2662 -40 156 -139 307 -258 398 -31 23 -92 58 -137 79 -160 75 60 70 -2808 69 -2082 0 -2584 -3 -2633 -14z" />
    </Art>
  );
}

/**
 * The GitHub mark.
 *
 * Inline rather than an `<img>` for the reason the favicon in `index.html` is inline: a
 * file request the dev server answers with a 404, and an icon that is missing for the one
 * second the network takes, are both worse than a kilobyte of path data.
 */
export function IconGitHub(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M9500 19989 c-1713 -86 -3357 -603 -4810 -1511 -1067 -668 -2031 -1570 -2787 -2608 -1036 -1425 -1685 -3125 -1852 -4860 -60 -619 -66 -1249 -16 -1847 120 -1439 556 -2854 1262 -4093 848 -1486 2057 -2733 3506 -3614 850 -517 1713 -881 2702 -1142 217 -58 222 -59 355 -58 118 0 145 4 213 26 220 73 390 243 465 465 l27 78 6 2470 c4 1897 8 2489 18 2550 57 368 158 624 377 958 153 232 179 307 179 502 -1 115 -4 139 -29 210 -70 204 -212 358 -405 440 -35 14 -141 44 -235 66 -565 130 -971 274 -1426 505 -810 410 -1397 1013 -1605 1648 -99 304 -112 652 -34 961 71 282 226 574 446 842 105 127 146 196 181 298 l27 80 5 806 5 806 831 -312 c458 -171 859 -320 893 -329 41 -11 97 -17 169 -17 93 0 131 6 288 45 622 154 1099 212 1754 210 670 -1 1163 -62 1775 -219 118 -30 157 -36 247 -36 71 0 128 6 169 17 34 9 435 158 893 329 l831 312 5 -806 5 -806 27 -80 c35 -102 76 -169 181 -298 350 -429 509 -852 494 -1317 -9 -282 -64 -495 -198 -762 -226 -453 -645 -875 -1214 -1221 -71 -43 -229 -128 -350 -187 -433 -213 -812 -345 -1351 -469 -94 -22 -199 -51 -233 -65 -190 -77 -342 -242 -409 -443 -22 -67 -26 -96 -26 -208 -1 -195 25 -270 178 -502 218 -331 321 -592 377 -958 10 -61 14 -655 18 -2550 l6 -2470 27 -80 c39 -115 92 -199 179 -285 87 -87 172 -140 284 -177 71 -24 95 -27 215 -27 133 0 139 0 355 58 560 148 1083 329 1547 537 1414 631 2640 1555 3624 2729 1155 1378 1902 3004 2199 4780 201 1204 175 2494 -75 3690 -313 1501 -983 2935 -1929 4130 -1150 1453 -2613 2528 -4321 3175 -996 376 -2014 586 -3083 635 -260 11 -713 11 -957 -1z m891 -1429 c513 -26 954 -81 1391 -176 2097 -453 3889 -1620 5165 -3364 781 -1068 1322 -2383 1523 -3700 73 -481 95 -791 94 -1330 0 -466 -12 -670 -59 -1050 -252 -2010 -1193 -3844 -2681 -5225 -673 -625 -1464 -1152 -2284 -1522 -197 -89 -653 -273 -677 -273 -2 0 -3 837 -3 1859 0 1188 -4 1915 -10 2013 -21 307 -94 668 -188 936 -27 77 -37 115 -29 117 350 121 654 249 952 401 1212 616 2065 1553 2361 2592 173 608 165 1239 -23 1827 -108 339 -277 676 -479 960 l-79 110 -5 1190 -6 1190 -22 75 c-97 315 -366 520 -682 521 -54 1 -125 -6 -165 -16 -38 -8 -616 -221 -1282 -471 l-1213 -455 -187 40 c-614 131 -1132 185 -1783 184 -681 0 -1214 -54 -1823 -184 l-187 -40 -1213 454 c-666 251 -1230 460 -1252 467 -72 20 -201 29 -272 19 -297 -41 -523 -239 -610 -534 -16 -55 -18 -152 -23 -1250 l-5 -1190 -78 -110 c-296 -414 -500 -899 -582 -1381 -63 -368 -58 -770 14 -1139 172 -884 747 -1724 1621 -2366 488 -359 1113 -677 1757 -894 8 -2 -2 -40 -29 -117 -58 -165 -123 -429 -152 -618 -35 -228 -46 -419 -46 -787 l0 -316 -71 7 c-41 4 -108 20 -159 39 -148 56 -252 129 -355 247 -74 85 -112 155 -180 330 -105 272 -218 472 -376 667 -80 99 -242 261 -339 339 -198 160 -470 309 -707 387 -283 92 -460 117 -849 117 -311 0 -366 -9 -503 -80 -243 -126 -381 -355 -382 -631 -2 -325 206 -599 521 -689 65 -18 114 -23 360 -29 301 -9 332 -13 462 -66 157 -64 312 -202 406 -362 17 -29 54 -115 83 -190 28 -76 80 -196 116 -268 279 -563 801 -993 1418 -1168 153 -43 234 -57 503 -83 l52 -5 0 -825 c0 -453 -2 -824 -4 -824 -2 0 -50 18 -107 39 -655 246 -1213 530 -1774 904 -2082 1390 -3453 3604 -3759 6072 -49 396 -60 588 -60 1060 -1 527 18 806 85 1265 196 1347 743 2686 1539 3770 927 1262 2126 2225 3530 2835 842 366 1674 579 2610 670 346 34 816 43 1191 25z" />
    </Art>
  );
}

/**
 * The globe.
 *
 * Drawn rather than set as the 🌐 emoji: the emoji renders as a different picture at a
 * different weight on every platform this runs on, and next to a monospace language code
 * it comes out either cartoonish or invisible depending on the machine.
 */
export function IconGlobe(props: IconProps): React.JSX.Element {
  return (
    <Art {...props}>
      <path d="M9665 19994 c-342 -11 -883 -62 -1216 -114 -1881 -295 -3637 -1121 -5059 -2379 -227 -201 -684 -657 -886 -886 -1265 -1429 -2088 -3178 -2384 -5064 -79 -505 -113 -971 -113 -1551 0 -592 34 -1053 117 -1576 299 -1872 1122 -3618 2375 -5034 201 -227 657 -684 886 -886 1429 -1265 3178 -2088 5064 -2384 505 -79 971 -113 1551 -113 580 0 1046 34 1551 113 1886 296 3635 1119 5064 2384 229 202 685 659 886 886 1258 1422 2084 3178 2379 5059 79 505 113 971 113 1551 0 474 -11 688 -58 1131 -184 1709 -846 3393 -1893 4813 -467 632 -1133 1327 -1767 1842 -875 710 -1935 1298 -3010 1667 -845 291 -1666 457 -2583 522 -210 15 -801 26 -1017 19z m-1208 -1606 c-19 -29 -76 -118 -127 -198 -1381 -2144 -2283 -4720 -2543 -7260 l-22 -215 -2153 -3 c-2091 -2 -2152 -2 -2152 17 0 47 43 413 66 561 100 649 272 1286 502 1860 380 950 866 1744 1536 2510 162 184 526 550 726 729 779 695 1583 1192 2560 1583 329 132 744 266 1065 343 122 30 538 121 568 124 4 1 -8 -23 -26 -51z m3248 12 c1335 -264 2639 -880 3695 -1745 340 -279 771 -693 1036 -995 671 -767 1156 -1560 1536 -2510 230 -574 402 -1211 502 -1860 23 -148 66 -514 66 -561 0 -19 -61 -19 -2152 -17 l-2153 3 -22 215 c-154 1511 -532 3027 -1122 4502 -370 925 -886 1927 -1421 2758 -51 80 -109 169 -128 198 -27 43 -30 53 -15 49 10 -3 90 -20 178 -37z m-1653 -362 c93 -128 335 -490 476 -713 543 -859 1045 -1881 1403 -2857 384 -1046 637 -2050 794 -3148 40 -279 75 -591 68 -602 -2 -5 -1259 -8 -2793 -8 -1534 0 -2791 3 -2793 8 -15 24 77 701 153 1132 312 1762 926 3442 1837 5020 234 406 772 1230 803 1230 3 0 27 -28 52 -62z m-4265 -8968 c44 -433 133 -1030 214 -1440 419 -2116 1217 -4098 2367 -5880 66 -102 119 -186 118 -187 -4 -4 -409 83 -581 125 -1057 263 -2105 756 -2975 1400 -344 255 -620 492 -939 806 -879 867 -1504 1808 -1963 2956 -229 571 -395 1184 -497 1830 -27 175 -71 536 -71 589 l0 21 2152 -2 2153 -3 22 -215z m7006 213 c7 -13 -29 -334 -68 -603 -157 -1095 -401 -2068 -781 -3110 -427 -1175 -1005 -2305 -1704 -3335 -161 -237 -231 -335 -240 -335 -9 0 -79 98 -247 345 -696 1027 -1270 2152 -1697 3325 -380 1042 -624 2015 -781 3110 -39 269 -75 590 -68 603 2 4 1259 7 2793 7 1534 0 2791 -3 2793 -7z m5747 -14 c0 -53 -44 -414 -71 -589 -102 -646 -268 -1259 -497 -1830 -458 -1145 -1080 -2083 -1953 -2946 -328 -323 -601 -558 -949 -816 -871 -644 -1918 -1137 -2975 -1400 -173 -43 -577 -129 -582 -125 -1 1 53 85 118 187 1043 1610 1824 3461 2254 5345 151 665 275 1412 330 1995 9 96 18 181 21 188 3 9 442 12 2154 12 l2150 0 0 -21z" />
    </Art>
  );
}
