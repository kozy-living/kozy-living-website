import { getPrimaryMenu } from "@/lib/shopify";
import type { Menu } from "@/lib/shopify/types";
import MobileMenu from "./mobile-menu";
import DesktopMenu from "./desktop-menu";
import SearchTrigger from "./search";
import LogoSquare from "@/components/logo-square";
import CartModal from "@/components/cart/modal";
import { announcement, pillowTalkPath, site } from "@/lib/site";
import Link from "@/components/ui/intent-link";
import { UserIcon } from "@heroicons/react/24/outline";
import HeaderHeight from "./header-height";

const christmasLink: Menu = {
  title: "KHRISTMAS KAPSULE",
  path: pillowTalkPath,
};

const pillowTalkLink: Menu = {
  title: "Pillow Talk Capsule Collection",
  path: pillowTalkPath,
};

/**
 * Header: a quiet announcement line over the navigation.
 *
 * Shopify supplies the primary menu. The seasonal links follow Shop and appear inside its dropdown.
 *
 * LAYOUT NOTE: the mark is optically centred below `lg` and moves to the left
 * rail at `lg` and up. A seven-item menu with two flyouts simply does not fit
 * either side of a centred logo, so on desktop the logo leads the row and the
 * MENU is what is centred, between the logo and the utilities (see the grid
 * on the row). Phones keep the centred mark, where it fits and reads best.
 */
export async function Navbar() {
  // No customer-session read here: the header is on every page, and a
  // `cookies()` call in it makes every page uncacheable (see the note on
  // RootLayout). The account link always goes to `/account`, which shows
  // the sign-in panel to a signed-out visitor.
  const menu = await getPrimaryMenu();
  const headerMenu = menu
    .filter((item) => !/^[ck]hristmas(?: collection| capsule| kapsule)?(?: 🎁)?$/i.test(item.title.trim()))
    .flatMap((item) => {
      if (item.path !== "/search") return [item];
      const children = (item.items ?? []).filter(
        (child) => child.title.trim().toLowerCase() !== pillowTalkLink.title.toLowerCase()
      );
      return [{ ...item, items: [...children, pillowTalkLink] }, christmasLink];
    });

  return (
    <header
      data-site-header
      className="sticky top-0 z-[999] bg-paper/95 backdrop-blur-md"
    >
      <HeaderHeight />
      <div className="holiday-announcement">
        <div className="shell py-2 text-center">
          <Link href={pillowTalkPath} className="holiday-announcement-link text-spec text-paper">
            {announcement}
          </Link>
        </div>
      </div>

      <nav className="rule-t rule-b" aria-label="Primary">
        {/* lg and up: logo | menu | utilities on a three-column grid whose
            side columns grow EQUALLY (minmax(max-content, 1fr)), so the menu
            sits at the true centre of the row whenever there is room. Where
            there is not - seven items at 1024px - the sides shrink to their
            content and the menu slides over rather than overlapping either
            neighbour. Absolute centring overlapped the logo there. */}
        <div className="shell relative flex h-16 items-center gap-4 lg:grid lg:h-[4.5rem] lg:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] lg:gap-4 xl:gap-8">
          {/* Below lg this is the only nav affordance; from lg it disappears
              and DesktopMenu takes over. */}
          <MobileMenu menu={headerMenu} />

          <Link
            href="/"
            prefetch
            aria-label={`${site.name} home`}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 lg:static lg:translate-x-0 lg:translate-y-0 lg:justify-self-start"
          >
            <LogoSquare />
          </Link>

          <DesktopMenu menu={headerMenu} />

          <div className="ml-auto flex items-center gap-2 sm:gap-3 md:gap-4">
            <SearchTrigger menu={menu} />
            <CartModal />
            <Link
              href="/account"
              // Never prefetched: `/account` is per-customer and renders on
              // a function, so a prefetch on every page view is a function
              // call per visitor. (It used to point signed-out visitors at
              // the login route handler, where a prefetch ran the PKCE flow.)
              prefetch={false}
              aria-label="Account"
              className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full border border-ink/15 bg-card transition-colors hover:bg-ink hover:text-paper"
            >
              <UserIcon aria-hidden className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}

export type { Menu };
