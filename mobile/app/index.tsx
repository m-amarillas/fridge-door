import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Document } from '../lib/documents';
import { fetchDocuments } from '../lib/documents';

const INITIAL_LIMIT = 6;

const STATUS_COLORS: Record<Document['status'], string> = {
  pending:    '#888',
  queued:     '#f0a500',
  processing: '#4a9eff',
  indexed:    '#4caf50',
  failed:     '#f44336',
};

function DocumentCard({ doc }: { doc: Document }) {
  const [imgError, setImgError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const typeLabel = doc.document_type
    ? doc.document_type.replace(/_/g, ' ')
    : 'Document';
  const initial = typeLabel.charAt(0).toUpperCase();
  const formattedDate = new Date(doc.created_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const statusColor = STATUS_COLORS[doc.status];
  const imageSource = doc.image_url && !imgError ? { uri: doc.image_url } : null;

  return (
    <>
      <TouchableOpacity
        style={cardStyles.card}
        onPress={() => setFullscreen(true)}
        activeOpacity={0.85}
      >
        {imageSource ? (
          <Image
            source={imageSource}
            style={cardStyles.image}
            resizeMode="cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <View style={cardStyles.placeholder}>
            <Text style={cardStyles.initial}>{initial}</Text>
          </View>
        )}
        <View style={cardStyles.meta}>
          <Text style={cardStyles.type} numberOfLines={1}>{typeLabel}</Text>
          <View style={cardStyles.statusRow}>
            <View style={[cardStyles.dot, { backgroundColor: statusColor }]} />
            <Text style={cardStyles.date}>{formattedDate}</Text>
          </View>
        </View>
      </TouchableOpacity>

      <Modal
        visible={fullscreen}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreen(false)}
        statusBarTranslucent
      >
        <View style={modalStyles.backdrop}>
          <TouchableOpacity
            style={modalStyles.close}
            onPress={() => setFullscreen(false)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={modalStyles.closeText}>✕</Text>
          </TouchableOpacity>
          <ScrollView
            style={modalStyles.scroll}
            contentContainerStyle={modalStyles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {imageSource ? (
              <Image
                source={imageSource}
                style={modalStyles.image}
                resizeMode="contain"
              />
            ) : (
              <View style={modalStyles.noImage}>
                <Text style={modalStyles.noImageText}>No image available</Text>
              </View>
            )}
            <Text style={modalStyles.label}>{typeLabel}</Text>
            {doc.ocr_text ? (
              <Text style={modalStyles.ocrText}>{doc.ocr_text}</Text>
            ) : (
              <Text style={modalStyles.ocrPlaceholder}>
                {doc.status === 'indexed' ? 'No text extracted.' : `Processing… (${doc.status})`}
              </Text>
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch one extra to detect whether there are more beyond the initial limit.
      const limit = showAll ? undefined : INITIAL_LIMIT + 1;
      const docs = await fetchDocuments(limit);

      let visible = docs;
      if (!showAll && docs.length > INITIAL_LIMIT) {
        setHasMore(true);
        visible = docs.slice(0, INITIAL_LIMIT);
      } else {
        setHasMore(false);
      }

      setDocuments(visible);
    } catch {
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Search box */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search documents..."
          placeholderTextColor="#555"
          value={query}
          onChangeText={setQuery}
        />
      </View>

      {/* Gallery */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {loading ? (
          <ActivityIndicator color="#fff" style={styles.loader} />
        ) : documents.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No documents yet</Text>
            <Text style={styles.emptySubtitle}>
              Tap Scan below to capture your first school document.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.grid}>
              {documents.map((doc) => (
                <DocumentCard key={doc.id} doc={doc} />
              ))}
            </View>
            {hasMore && (
              <TouchableOpacity
                style={styles.showMoreBtn}
                onPress={() => setShowAll(true)}
              >
                <Text style={styles.showMoreText}>Show more</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>

      {/* Scan button */}
      <View style={styles.scanContainer}>
        <TouchableOpacity
          style={styles.scanButton}
          onPress={() => router.push('/scan')}
          activeOpacity={0.8}
        >
          <Text style={styles.scanText}>Scan</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  searchInput: {
    backgroundColor: '#1c1c1e',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 16,
  },
  loader: {
    marginTop: 60,
  },
  emptyState: {
    marginTop: 80,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtitle: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 4,
  },
  showMoreBtn: {
    marginTop: 16,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#444',
  },
  showMoreText: {
    color: '#aaa',
    fontSize: 14,
  },
  scanContainer: {
    padding: 16,
    paddingBottom: 24,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#1c1c1e',
  },
  scanButton: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  scanText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});

const cardStyles = StyleSheet.create({
  card: {
    width: '49%',
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    aspectRatio: 3 / 4,
  },
  placeholder: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: '#555',
    fontSize: 32,
    fontWeight: '600',
  },
  meta: {
    padding: 8,
  },
  type: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 4,
    textTransform: 'capitalize',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  date: {
    color: '#888',
    fontSize: 11,
  },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
  },
  close: {
    position: 'absolute',
    top: 56,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  closeText: {
    color: '#fff',
    fontSize: 20,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 96,
    paddingBottom: 48,
    paddingHorizontal: 16,
  },
  image: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: 8,
    overflow: 'hidden',
  },
  noImage: {
    aspectRatio: 3 / 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
  },
  noImageText: {
    color: '#555',
    fontSize: 16,
  },
  label: {
    color: '#aaa',
    fontSize: 13,
    marginTop: 16,
    marginBottom: 12,
    textTransform: 'capitalize',
  },
  ocrText: {
    color: '#ddd',
    fontSize: 14,
    lineHeight: 22,
    fontFamily: 'monospace',
  },
  ocrPlaceholder: {
    color: '#555',
    fontSize: 14,
    fontStyle: 'italic',
  },
});
