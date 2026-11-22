// Small building blocks in the restaurant's colors: text, buttons, cards, badges, rows, toasts.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '@/lib/session';
import type { Palette } from '@/lib/theme';
import { Icon, type IconName } from './Icon';

export const useColors = (): Palette => useSession().colors;

type TxtVariant = 'title' | 'h2' | 'h3' | 'body' | 'small' | 'tiny';
const SIZES: Record<TxtVariant, TextStyle> = {
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.4 },
  h2: { fontSize: 18, fontWeight: '700' },
  h3: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 16 },
  small: { fontSize: 14 },
  tiny: { fontSize: 12 },
};

export function Txt({ v = 'body', tone = 'text', style, children, lines, bold }: {
  v?: TxtVariant; tone?: 'text' | 'muted' | 'faint' | 'brand' | 'ok' | 'warn' | 'bad' | 'onBrand'; style?: StyleProp<TextStyle>; children: ReactNode; lines?: number; bold?: boolean;
}) {
  const c = useColors();
  const color = { text: c.text, muted: c.text2, faint: c.text3, brand: c.brand, ok: c.ok, warn: c.warn, bad: c.bad, onBrand: c.onBrand }[tone];
  return <Text numberOfLines={lines} style={[SIZES[v], { color }, bold && { fontWeight: '700' }, style]}>{children}</Text>;
}

type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ok';
export function Button({ title, onPress, kind = 'secondary', icon, disabled, busy, small, block, style, label }: {
  title: string; onPress?: () => void; kind?: ButtonKind; icon?: IconName; disabled?: boolean; busy?: boolean; small?: boolean; block?: boolean; style?: StyleProp<ViewStyle>; label?: string;
}) {
  const c = useColors();
  const look = {
    primary: { bg: c.brand, fg: c.onBrand, border: c.brand },
    secondary: { bg: c.surface, fg: c.text, border: c.border },
    ghost: { bg: 'transparent', fg: c.brand, border: 'transparent' },
    danger: { bg: c.surface, fg: c.bad, border: c.border },
    ok: { bg: c.ok, fg: '#ffffff', border: c.ok },
  }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label || title} accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.btn, small && styles.btnSmall, block && { alignSelf: 'stretch' },
        { backgroundColor: look.bg, borderColor: look.border, opacity: off ? 0.55 : pressed ? 0.8 : 1 }, style]}>
      {busy ? <ActivityIndicator size="small" color={look.fg} /> : icon ? <Icon name={icon} size={small ? 16 : 18} color={look.fg} /> : null}
      <Text style={[styles.btnText, small && { fontSize: 14 }, { color: look.fg }]} numberOfLines={2}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style, pad = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; pad?: boolean }) {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, pad && { padding: 16 }, style]}>{children}</View>;
}

export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad';
export function Badge({ text, tone = 'neutral' }: { text: string; tone?: Tone }) {
  const c = useColors();
  const [bg, fg] = { neutral: [c.surface2, c.text2], brand: [c.brandSoft, c.brand], ok: [c.okSoft, c.ok], warn: [c.warnSoft, c.warn], bad: [c.badSoft, c.bad] }[tone];
  return <View style={[styles.badge, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{text}</Text></View>;
}

export function Notice({ text, tone = 'brand', icon = 'alert', children }: { text?: string; tone?: Tone; icon?: IconName; children?: ReactNode }) {
  const c = useColors();
  const [bg, fg] = { neutral: [c.surface2, c.text2], brand: [c.brandSoft, c.text], ok: [c.okSoft, c.ok], warn: [c.warnSoft, c.warn], bad: [c.badSoft, c.bad] }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: bg }]}>
      <Icon name={icon} size={18} color={fg} />
      <View style={{ flex: 1, gap: 8 }}>{text ? <Text style={{ color: fg, fontSize: 14, lineHeight: 20 }}>{text}</Text> : null}{children}</View>
    </View>
  );
}

export function Empty({ icon = 'calendar', title, body, children }: { icon?: IconName; title: string; body?: string; children?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={32} color={c.text3} />
      <Txt v="h3" tone="muted" style={{ textAlign: 'center' }}>{title}</Txt>
      {body ? <Txt v="small" tone="faint" style={{ textAlign: 'center' }}>{body}</Txt> : null}
      {children}
    </View>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Txt v="h3" style={{ flex: 1 }}>{title}</Txt>
      {right}
    </View>
  );
}

export function Row({ children, style, gap = 8 }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

/** A tappable row for menus: icon, title (and a line under it), something on the right. */
export function ListRow({ icon, title, sub, right, onPress, danger, chevron = !!onPress, label, selected }: {
  icon?: IconName; title: string; sub?: string; right?: ReactNode; onPress?: () => void; danger?: boolean; chevron?: boolean; label?: string; selected?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={label}
      accessibilityState={selected != null ? { selected } : undefined}
      style={({ pressed }) => [styles.listRow, { borderColor: c.border, backgroundColor: pressed ? c.surface2 : 'transparent' }]}>
      {icon ? <Icon name={icon} size={20} color={danger ? c.bad : c.text2} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt tone={danger ? 'bad' : 'text'} style={{ fontWeight: '600' }}>{title}</Txt>
        {sub ? <Txt v="small" tone="muted">{sub}</Txt> : null}
      </View>
      {right}
      {chevron ? <Icon name="right" size={18} color={c.text3} /> : null}
    </Pressable>
  );
}

/** Two or three choices side by side (Everyone / Just me). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <View style={[styles.seg, { backgroundColor: c.surface2, borderColor: c.border }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[styles.segItem, on && { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? '700' : '500', fontSize: 14, textAlign: 'center' }} numberOfLines={2}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Tabs inside a screen (Up for grabs / My requests) with counts; they wrap on narrow screens. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map((tb) => {
        const on = tb.value === value;
        return (
          <Pressable key={tb.value} onPress={() => onChange(tb.value)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={[styles.tab, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : c.surface }]}>
            <Text style={{ color: on ? c.brand : c.text2, fontWeight: '700', fontSize: 14 }}>{tb.label}</Text>
            {tb.count ? <View style={[styles.count, { backgroundColor: on ? c.brand : c.text3 }]}><Text style={{ color: on ? c.onBrand : '#fff', fontSize: 11, fontWeight: '800' }}>{tb.count}</Text></View> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Choices you can turn on and off (filters); they wrap. With `single`, picking one turns the others off. */
export function Chips<T extends string>({ options, value, onChange, single, label }: {
  options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void; single?: boolean; label?: string;
}) {
  const c = useColors();
  return (
    <View style={styles.chips} accessibilityLabel={label}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <Pressable key={o.value} onPress={() => onChange(single ? (on ? [] : [o.value]) : on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            accessibilityRole={single ? 'radio' : 'checkbox'} accessibilityState={single ? { selected: on } : { checked: on }} accessibilityLabel={o.label}
            style={({ pressed }) => [styles.chip, { borderColor: on ? c.brand : c.border, backgroundColor: on ? c.brandSoft : pressed ? c.surface2 : c.surface }]}>
            {on ? <Icon name="check" size={14} color={c.brand} /> : null}
            <Text style={{ color: on ? c.brand : c.text2, fontWeight: '700', fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "No connection. Showing what you last saw (Nov 22, 3:42 PM)." for screens that keep a copy on the phone. */
export function OfflineNote({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={[styles.offline, { backgroundColor: c.warnSoft }]} accessibilityLiveRegion="polite" accessibilityLabel={text}>
      <Icon name="clock" size={16} color={c.warn} />
      <Text style={{ color: c.warn, fontSize: 13, fontWeight: '600', flex: 1 }}>{text}</Text>
    </View>
  );
}

export function Field({ label, help, ...input }: TextInputProps & { label: string; help?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Txt v="small" tone="muted" bold>{label}</Txt>
      <TextInput placeholderTextColor={c.text3} {...input}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }, input.multiline && { minHeight: 80, textAlignVertical: 'top' }, input.style]} />
      {help ? <Txt v="small" tone="faint">{help}</Txt> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const c = useColors();
  return <View style={styles.empty}><ActivityIndicator color={c.brand} />{label ? <Txt v="small" tone="faint">{label}</Txt> : null}</View>;
}

export function JobDot({ color }: { color?: string }) {
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color || '#999' }} />;
}

// ---------- toasts ----------
type ToastKind = 'ok' | 'bad';
const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; kind: ToastKind } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const show = useCallback((text: string, kind: ToastKind = 'ok') => {
    setToast({ text, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={[styles.toastWrap, { bottom: insets.bottom + 72 }]} accessibilityLiveRegion="polite">
          <View style={[styles.toast, { backgroundColor: toast.kind === 'bad' ? '#7f1d1d' : '#0f172a' }]}>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' }}>{toast.text}</Text>
          </View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  btnSmall: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 },
  btnText: { fontSize: 16, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  notice: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, alignItems: 'flex-start' },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 16 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20, marginBottom: 8 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  seg: { flexDirection: 'row', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segItem: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent', paddingHorizontal: 8 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  tab: { minHeight: 44, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, maxWidth: 480 },
});
