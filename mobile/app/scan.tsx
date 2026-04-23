import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ActionCard } from '../components/ActionCard';
import type { Action, UploadResult } from '../lib/api';
import { fetchActions, uploadDocument } from '../lib/api';
import { useDocumentRealtime } from '../lib/realtime';

type Phase = 'camera' | 'preview' | 'uploading' | 'result';

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('camera');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const cameraRef = useRef<CameraView>(null);

  const documentId = uploadResult?.document_id ?? null;
  const { status: liveStatus, actionsStatus } = useDocumentRealtime(documentId);

  // After upload the API confirms status is 'queued'. Use that as the floor
  // until the first Realtime UPDATE arrives.
  const effectiveStatus = liveStatus ?? (documentId ? 'queued' : null);

  useEffect(() => {
    if (actionsStatus === 'ready' && documentId) {
      fetchActions(documentId)
        .then(r => setActions(r.actions))
        .catch(() => {});
    }
  }, [actionsStatus, documentId]);

  if (!permission) {
    return (
      <View style={styles.center}>
        <Text>Checking camera permission...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera permission required.</Text>
        <Button title="Grant Permission" onPress={requestPermission} />
      </View>
    );
  }

  async function takePicture() {
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
    if (photo) {
      setPhotoUri(photo.uri);
      setPhase('preview');
    }
  }

  async function handleUpload() {
    if (!photoUri) return;
    setPhase('uploading');
    setUploadError(null);
    try {
      const result = await uploadDocument(photoUri);
      setUploadResult(result);
      setPhase('result');
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : 'Unknown error');
      setPhase('preview');
    }
  }

  function handleRetake() {
    setPhotoUri(null);
    setUploadResult(null);
    setUploadError(null);
    setActions([]);
    setDismissedIds(new Set());
    setPhase('camera');
  }

  if (phase === 'camera') {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>✕</Text>
        </TouchableOpacity>
        <CameraView ref={cameraRef} style={styles.camera} facing="back">
          <View style={styles.captureRow}>
            <TouchableOpacity style={styles.captureButton} onPress={takePicture} />
          </View>
        </CameraView>
      </View>
    );
  }

  if ((phase === 'preview' || phase === 'uploading' || phase === 'result') && !photoUri) {
    return null;
  }

  if (phase === 'preview' || phase === 'uploading') {
    return (
      <View style={styles.container}>
        <Image source={{ uri: photoUri ?? undefined }} style={styles.preview} resizeMode="contain" />
        {uploadError && <Text style={styles.error}>{uploadError}</Text>}
        <View style={styles.row}>
          <Button title="Retake" onPress={handleRetake} disabled={phase === 'uploading'} />
          <Button
            title={phase === 'uploading' ? 'Uploading...' : 'Upload'}
            onPress={handleUpload}
            disabled={phase === 'uploading'}
          />
        </View>
      </View>
    );
  }

  // Result phase — live status tracking after upload.
  const isProcessing = effectiveStatus === 'queued' || effectiveStatus === 'processing';
  // actionsStatus being non-null guarantees the document is indexed — the worker
  // always sets status=indexed before touching actions_status. This covers the
  // race where the status UPDATE fires before the Realtime subscription is ready.
  const isIndexed = effectiveStatus === 'indexed' || actionsStatus !== null;
  const isDocFailed = effectiveStatus === 'failed';
  const visibleActions = actions.filter(a => !dismissedIds.has(a.id));

  return (
    <View style={styles.container}>
      <Image source={{ uri: photoUri ?? undefined }} style={resultStyles.thumbnail} resizeMode="contain" />
      <ScrollView style={styles.resultScroll} contentContainerStyle={resultStyles.scrollContent}>
        {isProcessing && (
          <View style={resultStyles.statusRow}>
            <ActivityIndicator color="#fff" />
            <Text style={resultStyles.statusText}>Processing your document...</Text>
          </View>
        )}
        {isDocFailed && (
          <Text style={resultStyles.errorText}>Processing failed. Please try scanning again.</Text>
        )}
        {isIndexed && (
          <>
            {(actionsStatus === null || actionsStatus === 'analyzing') && (
              <View style={resultStyles.statusRow}>
                <ActivityIndicator color="#aaa" size="small" />
                <Text style={resultStyles.statusText}>Finding actions...</Text>
              </View>
            )}
            {actionsStatus === 'ready' && visibleActions.length > 0 && (
              <>
                <Text style={resultStyles.sectionLabel}>Suggested actions</Text>
                {visibleActions.map(a => (
                  <ActionCard
                    key={a.id}
                    action={a}
                    onDismiss={() => setDismissedIds(prev => new Set(prev).add(a.id))}
                  />
                ))}
              </>
            )}
            {actionsStatus === 'ready' && visibleActions.length === 0 && (
              <Text style={resultStyles.quietText}>
                {actions.length === 0 ? 'No actions needed.' : 'All done.'}
              </Text>
            )}
            {actionsStatus === 'failed' && (
              <Text style={resultStyles.quietText}>Couldn't extract actions from this document.</Text>
            )}
          </>
        )}
      </ScrollView>
      <View style={styles.row}>
        <Button title="Scan Another" onPress={handleRetake} />
        <Button title="Done" onPress={() => router.replace('/')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  camera: { flex: 1 },
  backButton: {
    position: 'absolute',
    top: 56,
    left: 20,
    zIndex: 10,
    padding: 8,
  },
  backText: { color: '#fff', fontSize: 20 },
  captureRow: {
    position: 'absolute',
    bottom: 40,
    width: '100%',
    alignItems: 'center',
  },
  captureButton: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: '#aaa',
  },
  preview: { flex: 1, width: '100%' },
  resultScroll: { flex: 1 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 20,
    gap: 20,
    backgroundColor: '#000',
  },
  error: { color: 'red', padding: 12, textAlign: 'center' },
  text: { marginBottom: 12 },
});

const resultStyles = StyleSheet.create({
  thumbnail: {
    width: '100%',
    height: 200,
  },
  scrollContent: {
    padding: 16,
    gap: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  statusText: {
    color: '#aaa',
    fontSize: 14,
  },
  sectionLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  quietText: {
    color: '#555',
    fontSize: 14,
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  errorText: {
    color: '#f44336',
    fontSize: 14,
    paddingVertical: 8,
  },
});
