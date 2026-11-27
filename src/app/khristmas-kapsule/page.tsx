import type { Metadata } from "next";
import Image from "next/image";
import Grid from "@/components/grid";
import ProductGridItems from "@/components/layout/product-grid-items";
import SortMenu from "@/components/shop/sort-menu";
import { Headline } from "@/components/ui/section";
import { getCatalog, getCollectionProductOrder } from "@/lib/shopify";
import { sorting } from "@/lib/constants";
import { sortProducts } from "@/lib/shop/filters";
import styles from "./seasonal.module.css";

const path = "/khristmas-kapsule";
const handle = "pillow-talk";
export const metadata: Metadata = {
  title: "Khristmas Kapsule Kollection",
  description: "Explore the festive Pillow Talk Kollection by Kozy Living.",
  alternates: { canonical: path },
};

export default async function KhristmasPage({ searchParams }: {
  searchParams?: Promise<{ sort?: string | string[] }>;
}) {
  const [catalog, order, params] = await Promise.all([
    getCatalog(), getCollectionProductOrder(handle), searchParams,
  ]);
  const rank = new Map(catalog.map((p, i) => [p.id, i]));
  const position = new Map((order ?? []).map((id, i) => [id, i]));
  const scope = catalog.filter((p) => p.collections.some((c) => c.handle === handle));
  scope.sort((a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const sort = sorting.find((item) => item.slug === params?.sort)?.slug ?? null;
  const products = sortProducts(scope, sort, rank);
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="festive-title">
        <h1 id="festive-title" className={styles.visuallyHidden}>Khristmas Kapsule Kollection</h1>
        <Image src="/media/khristmas-kapsule-final.webp" alt="The Festive Edit — Khristmas Kapsule Kollection. Krafted textiles, Kozy pieces and matching moments for you and your companion." width={1672} height={941} priority sizes="100vw" className={styles.banner} unoptimized />
      </section>
      <section className="shell" id="khristmas-products" style={{scrollMarginTop: "calc(var(--header-h) + 1rem)"}}>
        <div className={styles.heading}>
          <Headline split={false}>Shop the Khristmas Kollection</Headline>
          <div className={styles.rule} aria-hidden>◇</div>
        </div>
        <div className={styles.toolbar}>
          <p>{products.length} {products.length === 1 ? "Product" : "Products"}</p>
          <SortMenu options={sorting.map((item) => ({title: item.title, href: item.slug ? `${path}?sort=${item.slug}` : path, active: item.slug === sort}))} />
        </div>
        {products.length ? <Grid className="grid-cols-2 lg:grid-cols-4"><ProductGridItems products={products} sizes="(min-width: 1024px) 25vw, 50vw" /></Grid> : <p className="py-16 text-center">This Kollection is currently unavailable.</p>}
      </section>
    </div>
  );
}
