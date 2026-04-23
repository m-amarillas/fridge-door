import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import {
	Button,
	Image,
	ScrollView,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { uploadDocument, type UploadResult } from "../lib/api";

type Phase = "camera" | "preview" | "uploading" | "result";

export default function ScanScreen() {
	const router = useRouter();
	const [permission, requestPermission] = useCameraPermissions();
	const [phase, setPhase] = useState<Phase>("camera");
	const [photoUri, setPhotoUri] = useState<string | null>(null);
	const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const cameraRef = useRef<CameraView>(null);

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
			setPhase("preview");
		}
	}

	async function handleUpload() {
		if (!photoUri) return;
		setPhase("uploading");
		setUploadError(null);
		try {
			const result = await uploadDocument(photoUri);
			setUploadResult(result);
			setPhase("result");
		} catch (e: unknown) {
			setUploadError(e instanceof Error ? e.message : "Unknown error");
			setPhase("preview");
		}
	}

	function handleRetake() {
		setPhotoUri(null);
		setUploadResult(null);
		setUploadError(null);
		setPhase("camera");
	}

	if (phase === "camera") {
		return (
			<View style={styles.container}>
				<TouchableOpacity
					style={styles.backButton}
					onPress={() => router.back()}
				>
					<Text style={styles.backText}>✕</Text>
				</TouchableOpacity>
				<CameraView ref={cameraRef} style={styles.camera} facing="back">
					<View style={styles.captureRow}>
						<TouchableOpacity
							style={styles.captureButton}
							onPress={takePicture}
						/>
					</View>
				</CameraView>
			</View>
		);
	}

	if (phase === "preview" || phase === "uploading") {
		return (
			<View style={styles.container}>
				<Image
					source={{ uri: photoUri! }}
					style={styles.preview}
					resizeMode="contain"
				/>
				{uploadError && <Text style={styles.error}>{uploadError}</Text>}
				<View style={styles.row}>
					<Button
						title="Retake"
						onPress={handleRetake}
						disabled={phase === "uploading"}
					/>
					<Button
						title={phase === "uploading" ? "Processing..." : "Upload"}
						onPress={handleUpload}
						disabled={phase === "uploading"}
					/>
				</View>
			</View>
		);
	}

	// result phase
	return (
		<View style={styles.container}>
			<Image
				source={{ uri: photoUri! }}
				style={styles.thumbnail}
				resizeMode="contain"
			/>
			<Text style={styles.label}>OCR Result</Text>
			<ScrollView
				style={styles.resultScroll}
				contentContainerStyle={styles.resultContent}
			>
				<Text style={styles.resultText}>{uploadResult?.text ?? ""}</Text>
			</ScrollView>
			<View style={styles.row}>
				<Button title="Scan Another" onPress={handleRetake} />
				<Button title="Done" onPress={() => router.replace("/")} />
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: "#000" },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		padding: 20,
	},
	camera: { flex: 1 },
	backButton: {
		position: "absolute",
		top: 56,
		left: 20,
		zIndex: 10,
		padding: 8,
	},
	backText: { color: "#fff", fontSize: 20 },
	captureRow: {
		position: "absolute",
		bottom: 40,
		width: "100%",
		alignItems: "center",
	},
	captureButton: {
		width: 70,
		height: 70,
		borderRadius: 35,
		backgroundColor: "#fff",
		borderWidth: 4,
		borderColor: "#aaa",
	},
	preview: { flex: 1, width: "100%" },
	thumbnail: { width: "100%", height: 180, marginBottom: 8 },
	label: {
		color: "#fff",
		fontSize: 14,
		fontWeight: "600",
		paddingHorizontal: 16,
		paddingTop: 8,
	},
	resultScroll: { flex: 1, marginTop: 8 },
	resultContent: { padding: 16 },
	resultText: {
		color: "#eee",
		fontSize: 14,
		lineHeight: 22,
		fontFamily: "monospace",
	},
	row: {
		flexDirection: "row",
		justifyContent: "space-around",
		padding: 20,
		gap: 20,
		backgroundColor: "#000",
	},
	error: { color: "red", padding: 12, textAlign: "center" },
	text: { marginBottom: 12 },
});
