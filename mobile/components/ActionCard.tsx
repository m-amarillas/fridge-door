import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Action } from '../lib/api';

const TYPE_LABELS: Record<string, string> = {
  calendar_event: 'Calendar',
  task: 'Task',
  reminder: 'Reminder',
  note: 'Note',
};

function getDetail(action: Action): string | null {
  const p = action.payload;
  if (action.action_type === 'calendar_event' && p.date) {
    return p.all_day ? String(p.date) : `${p.date}${p.time ? ` at ${p.time}` : ''}`;
  }
  if (action.action_type === 'task' && p.due_date) return `Due ${p.due_date}`;
  if (action.action_type === 'reminder' && p.message) return String(p.message);
  if (action.action_type === 'note' && p.content) return String(p.content);
  return null;
}

export function ActionCard({ action, onDismiss }: { action: Action; onDismiss: () => void }) {
  const title = String(action.payload.title ?? '');
  const detail = getDetail(action);

  return (
    <View style={styles.card}>
      <Text style={styles.type}>{TYPE_LABELS[action.action_type] ?? action.action_type}</Text>
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail} numberOfLines={2}>{detail}</Text> : null}
      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.doIt} onPress={onDismiss}>
          <Text style={styles.doItText}>Do it</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.notNow} onPress={onDismiss}>
          <Text style={styles.notNowText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  type: {
    color: '#888',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  detail: {
    color: '#aaa',
    fontSize: 13,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  doIt: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  doItText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '600',
  },
  notNow: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  notNowText: {
    color: '#888',
    fontSize: 14,
  },
});
