// Training: a placeholder until the Training portal ships (menu study guide with photos and
// allergens, quizzes, leaderboard, employee manual, manager-on-duty card). When it does, it
// becomes a tab: see src/navigation.ts.
import { Screen } from '@/components/Screen';
import { Badge, Card, Empty } from '@/components/ui';
import { useI18n } from '@/i18n';

export default function Training() {
  const { t } = useI18n();
  return (
    <Screen title={t('training.title')} back bottomInset>
      <Card>
        <Empty icon="book" title={t('training.soon')} body={t('training.body')}>
          <Badge tone="brand" text={t('more.soon')} />
        </Empty>
      </Card>
    </Screen>
  );
}
