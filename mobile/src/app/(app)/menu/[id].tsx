// One menu item: its photos, 86'd (on the menu or today's 86 List), the description, allergens, dietary tags and
// what's in it, then how to sell it, the recipe and prep notes, but only those the server sends this person
// (recipes and prep notes are usually for the kitchen and bar). In Spanish where the restaurant wrote it.
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { Gallery } from '@/components/training/Gallery';
import { useMenu } from '@/components/training/useMenu';
import { Badge, Button, Card, Empty, Loading, Notice, Row, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { money } from '@/lib/training';

export default function MenuItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const c = useColors();
  const { has } = useSession();
  const { view: menu, error, reload } = useMenu();
  const it = menu?.items.find((x) => x.id === id);
  if (!it) {
    return (
      <Screen title={t('training.tabs.menu')} back bottomInset>
        {menu ? <Card><Empty icon="search" title={t('menu.notFound')} /></Card>
          : error ? <Empty icon="alert" title={t('common.networkError')}><Button title={t('common.retry')} onPress={reload} /></Empty> : <Loading />}
      </Screen>
    );
  }
  const out86 = !it.eightySixed && menu!.out86.has(it.id);
  const sub = [menu!.cat(it.category), money(it.price)].filter(Boolean).join(' · ');
  const recipe = it.recipe && (it.recipe.ingredients.length || it.recipe.steps.length) ? it.recipe : null;
  return (
    <Screen title={it.name} back bottomInset onRefresh={reload}>
      {it.photos.length ? <Gallery photos={it.photos} name={it.name} /> : null}
      <View style={{ gap: 2 }}>
        <Txt v="title">{it.name}</Txt>
        {sub ? <Txt tone="muted">{sub}</Txt> : null}
      </View>
      {it.eightySixed ? <Notice tone="bad" icon="ban" text={t('menu.is86')} /> : null}
      {out86 ? (
        <Notice tone="bad" icon="ban" text={t('menu.outTodayDetail')}>
          {has('eightySix') ? <Button small title={t('more.eightySix')} onPress={() => router.push('/eighty-six')} style={{ alignSelf: 'flex-start' }} /> : null}
        </Notice>
      ) : null}
      {it.description ? <Txt style={{ lineHeight: 23 }}>{it.description}</Txt> : null}

      <Card style={{ gap: 14 }}>
        <Fact title={t('menu.allergens')}>
          {it.allergens.length ? (
            <View style={styles.badges}>{it.allergens.map((a) => <Badge key={a} tone="bad" text={menu!.allergenName(a)} />)}</View>
          ) : <Txt v="small" tone="muted">{t('menu.noMajorAllergens')}</Txt>}
        </Fact>
        {it.dietary.length ? (
          <Fact title={t('menu.dietary')}>
            <View style={styles.badges}>{it.dietary.map((d) => <Badge key={d} tone="ok" text={menu!.diet(d)} />)}</View>
          </Fact>
        ) : null}
        {it.keyIngredients.length ? <Fact title={t('menu.whatsInIt')}><Txt>{it.keyIngredients.join(', ')}</Txt></Fact> : null}
      </Card>

      {it.selling && (it.selling.notes || it.selling.pairings) ? (
        <Card style={{ gap: 8 }}>
          <Txt v="h3">{t('menu.selling')}</Txt>
          {it.selling.notes ? <Txt style={{ lineHeight: 23 }}>{it.selling.notes}</Txt> : null}
          {it.selling.pairings ? <Txt><Txt bold>{t('menu.pairings')}: </Txt>{it.selling.pairings}</Txt> : null}
        </Card>
      ) : null}
      {recipe ? (
        <Card style={{ gap: 10 }}>
          <Row style={{ flexWrap: 'wrap' }}>
            <Txt v="h3">{t('menu.recipe')}</Txt>
            {recipe.yield ? <Txt v="small" tone="muted">{t('menu.makes', { amount: recipe.yield })}</Txt> : null}
          </Row>
          {recipe.ingredients.map((r, i) => (
            <View key={i} style={[styles.ing, { borderColor: c.border }]}>
              <Txt bold style={styles.qty}>{r.qty}</Txt>
              <Txt style={{ flex: 1 }}>{r.item}</Txt>
            </View>
          ))}
          {recipe.steps.map((s, i) => (
            <View key={`s${i}`} style={styles.step}>
              <View style={[styles.num, { backgroundColor: c.brandSoft }]}><Txt v="small" tone="brand" bold>{i + 1}</Txt></View>
              <Txt style={{ flex: 1, lineHeight: 22 }}>{s}</Txt>
            </View>
          ))}
        </Card>
      ) : null}
      {it.prep?.notes ? (
        <Card style={{ gap: 8 }}>
          <Txt v="h3">{t('menu.prep')}</Txt>
          <Txt style={{ lineHeight: 23 }}>{it.prep.notes}</Txt>
        </Card>
      ) : null}
      {!it.can.recipe || !it.can.prep ? (
        <Row style={{ alignItems: 'flex-start' }}>
          <Icon name="lock" size={16} color={c.text3} />
          <Txt v="small" tone="faint" style={{ flex: 1 }}>{t('menu.locked')}</Txt>
        </Row>
      ) : null}
    </Screen>
  );
}

function Fact({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt v="tiny" tone="muted" bold style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ing: { flexDirection: 'row', gap: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  qty: { minWidth: 70 },
  step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  num: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
