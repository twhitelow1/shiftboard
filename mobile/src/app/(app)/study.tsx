// Flashcards: photo → name, name → allergens, or name → what's in it, for the whole menu or one section.
// Tap the card to flip it; swipe or use the buttons to move; Shuffle mixes the deck. 86'd items are left out.
import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { TrainingPhoto } from '@/components/TrainingPhoto';
import { useMenu } from '@/components/training/useMenu';
import { Badge, Button, Card, Empty, Loading, Row, Segmented, Txt, useColors } from '@/components/ui';
import { useI18n } from '@/i18n';

type Mode = 'photo' | 'allergens' | 'ingredients';

export default function Study() {
  const { t } = useI18n();
  const c = useColors();
  const { view: menu } = useMenu();
  const [mode, setMode] = useState<Mode>('photo');
  const [cat, setCat] = useState('');
  const [seed, setSeed] = useState(0);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const deck = useMemo(() => {
    if (!menu) return [];
    let cards = menu.items.filter((it) => !it.eightySixed && (!cat || it.category === cat) && (mode !== 'photo' || it.photos.length));
    if (seed) cards = cards.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
    return cards;
  }, [menu, mode, cat, seed]);
  const reset = (fn: () => void) => { fn(); setI(0); setFlipped(false); };
  const move = (d: number) => { setFlipped(false); setI((x) => Math.max(0, Math.min(deck.length - 1, x + d))); };
  const moveRef = useRef(move);
  moveRef.current = move;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 20 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderRelease: (_, g) => { if (Math.abs(g.dx) > 50) moveRef.current(g.dx < 0 ? 1 : -1); },
  })).current;

  if (!menu) return <Screen title={t('study.title')} back bottomInset><Loading /></Screen>;
  const k = Math.min(i, Math.max(0, deck.length - 1));
  const card = deck[k];
  return (
    <Screen title={t('study.title')} back bottomInset>
      <Segmented value={mode} onChange={(m) => reset(() => setMode(m))} options={[
        { value: 'photo', label: t('study.modePhoto') }, { value: 'allergens', label: t('study.modeAllergens') }, { value: 'ingredients', label: t('study.modeIngredients') },
      ]} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[['', t('common.all')] as const, ...menu.categories.map((cg) => [cg, menu.cat(cg)] as const)].map(([v, label]) => {
          const on = cat === v;
          return (
            <Pressable key={v || 'all'} onPress={() => reset(() => setCat(on && v ? '' : v))} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={[styles.cat, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brand : c.surface }]}>
              <Text style={{ color: on ? c.onBrand : c.text2, fontWeight: '700', fontSize: 14 }}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {!card ? <Card><Empty icon="cards" title={mode === 'photo' ? t('study.noPhotos') : t('menu.noItems')} /></Card> : (
        <>
          <Pressable {...pan.panHandlers} onPress={() => setFlipped(!flipped)} accessibilityRole="button"
            accessibilityLabel={flipped ? t('study.showQuestion') : t('study.showAnswer')} accessibilityHint={t('study.tapToFlip')}
            style={[styles.card, { borderColor: flipped ? c.brand : c.border, backgroundColor: flipped ? c.brandSoft : c.surface }]}>
            {!flipped ? (
              mode === 'photo' ? (
                <>
                  <TrainingPhoto id={card.photos[0]?.id} style={styles.photo} />
                  <Txt v="small" tone="faint">{t('study.tapToFlip')}</Txt>
                </>
              ) : (
                <View style={styles.face}>
                  <Txt v="title" style={{ textAlign: 'center' }}>{card.name}</Txt>
                  <Txt tone="muted">{menu.cat(card.category)}</Txt>
                  <Txt v="h2" tone="brand" style={{ marginTop: 16, textAlign: 'center' }}>{mode === 'allergens' ? t('study.qAllergens') : t('study.qIngredients')}</Txt>
                  <Txt v="small" tone="faint">{t('study.tapToFlip')}</Txt>
                </View>
              )
            ) : (
              <View style={styles.face}>
                <Txt v={mode === 'photo' ? 'title' : 'h2'} style={{ textAlign: 'center' }}>{card.name}</Txt>
                {mode === 'photo' ? (
                  <>
                    <Txt tone="muted">{menu.cat(card.category)}</Txt>
                    {card.description ? <Txt v="small" style={{ textAlign: 'center' }}>{card.description}</Txt> : null}
                  </>
                ) : mode === 'allergens' ? (
                  <>
                    {card.allergens.length ? (
                      <View style={styles.badges}>{card.allergens.map((a) => <Badge key={a} tone="bad" text={menu.allergenName(a)} />)}</View>
                    ) : <Txt v="h3" style={{ textAlign: 'center' }}>{t('menu.noMajorAllergens')}</Txt>}
                    {card.dietary.length ? <Txt v="small" tone="muted">{card.dietary.map(menu.diet).join(' · ')}</Txt> : null}
                  </>
                ) : <Txt v="h3" style={{ textAlign: 'center' }}>{card.keyIngredients.length ? card.keyIngredients.join(', ') : t('study.noIngredients')}</Txt>}
              </View>
            )}
          </Pressable>
          <Row>
            <Button icon="left" title={t('common.previous')} disabled={k === 0} onPress={() => move(-1)} style={{ flex: 1 }} />
            <Txt v="small" tone="muted" style={{ minWidth: 64, textAlign: 'center' }}>{t('study.position', { n: k + 1, count: deck.length })}</Txt>
            <Button kind="primary" title={t('common.next')} disabled={k >= deck.length - 1} onPress={() => move(1)} style={{ flex: 1 }} />
          </Row>
          <Button kind="ghost" icon="shuffle" title={t('study.shuffle')} onPress={() => reset(() => setSeed((s) => s + 1))} />
          <Txt v="small" tone="faint" style={{ textAlign: 'center' }}>{t('study.help')}</Txt>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cat: { minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  card: { minHeight: 320, borderWidth: 2, borderRadius: 20, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 10, overflow: 'hidden' },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12 },
  face: { alignItems: 'center', gap: 8 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
});
