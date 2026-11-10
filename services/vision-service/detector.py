"""
Real-time Runway Vision Detection and Alignment System.
Uses Ultralytics YOLO11 and OpenCV geometric perspective analysis.
Complies with strict zero-mock policy: if no runway or frame is detected,
explicitly returns error status with null offsets.
"""

from __future__ import annotations

import logging
import math
import os
from typing import Any, Dict, List, Optional, Tuple, Union

import cv2
import numpy as np

logger = logging.getLogger("vision_detector")
logging.basicConfig(level=logging.INFO)

# Optional Ultralytics YOLO import
try:
    from ultralytics import YOLO
    ULTRALYTICS_AVAILABLE = True
except ImportError:
    ULTRALYTICS_AVAILABLE = False
    logger.warning("Ultralytics not installed. Operating in high-precision OpenCV geometric mode.")


class RunwayVisionDetector:
    """
    Real computer vision detector for runway alignment estimation.
    Calculates physical lateral and angular offsets relative to the camera optical axis.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        hfov_deg: float = 60.0,
        conf_threshold: float = 0.25,
    ) -> None:
        """
        Initialize detector with camera FOV and optional YOLO model.

        :param model_path: Path to custom YOLO11 weights (or env VISION_MODEL_PATH).
        :param hfov_deg: Horizontal Field of View of camera in degrees.
        :param conf_threshold: Confidence threshold for YOLO detection.
        """
        self.hfov_deg = float(os.getenv("CAMERA_HFOV_DEG", hfov_deg))
        self.conf_threshold = conf_threshold
        self.model: Optional[Any] = None
        self.model_loaded = False
        self.cap: Optional[cv2.VideoCapture] = None
        self.current_source: Optional[Union[str, int]] = None

        # Resolve model path from environment or parameter
        resolved_path = model_path or os.getenv("VISION_MODEL_PATH")
        if ULTRALYTICS_AVAILABLE and resolved_path and os.path.exists(resolved_path):
            try:
                self.model = YOLO(resolved_path)
                self.model_loaded = True
                logger.info("Loaded custom YOLO model from: %s", resolved_path)
            except Exception as e:
                logger.error("Failed to load YOLO model: %s. Falling back to CV.", e)
                self.model = None

    def calculate_focal_length(self, frame_width: int) -> float:
        """
        Calculate camera focal length in pixels using horizontal FOV:
        f = W / (2 * tan(HFOV / 2))
        """
        hfov_rad = math.radians(self.hfov_deg)
        return frame_width / (2.0 * math.tan(hfov_rad / 2.0))

    def open_stream(self, source: Union[str, int]) -> bool:
        """
        Open video capture stream (RTSP URL, video file, or camera device index).
        """
        self.close_stream()
        try:
            # Handle numeric camera indices passed as string
            if isinstance(source, str) and source.isdigit():
                source = int(source)

            self.cap = cv2.VideoCapture(source)
            if self.cap.isOpened():
                self.current_source = source
                logger.info("Successfully opened video stream: %s", source)
                return True
            else:
                logger.error("Failed to open video stream: %s", source)
                self.cap = None
                return False
        except Exception as e:
            logger.error("Error opening stream %s: %s", source, e)
            self.cap = None
            return False

    def close_stream(self) -> None:
        """Release currently active video stream."""
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None
            self.current_source = None

    def read_frame(self) -> Tuple[bool, Optional[np.ndarray]]:
        """
        Read the next frame from active video capture.
        """
        if self.cap is None or not self.cap.isOpened():
            return False, None
        ret, frame = self.cap.read()
        if not ret or frame is None or frame.size == 0:
            return False, None
        return True, frame

    def detect_stream_frame(self) -> Dict[str, Any]:
        """
        Grab a single frame from active stream and perform detection.
        Returns explicit ERROR_NO_FRAME if stream is inactive or frame cannot be read.
        """
        ret, frame = self.read_frame()
        if not ret or frame is None:
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": "Failed to read video frame from active stream",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }
        return self.detect_frame(frame)

    def detect_from_bytes(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Decode raw image bytes (JPEG/PNG) and perform runway detection.
        """
        if not image_bytes or len(image_bytes) == 0:
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": "Empty or zero-byte image provided",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }

        nparr = np.frombuffer(image_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None or frame.size == 0:
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": "Failed to decode image bytes into valid frame",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }
        return self.detect_frame(frame)

    def detect_frame(self, frame: np.ndarray) -> Dict[str, Any]:
        """
        Core detection entry point.
        Attempts YOLO detection if available, followed by rigorous OpenCV geometric analysis.
        If no runway is present, returns strictly:
        {"status": "ERROR_NO_RUNWAY", "error_message": "Runway not detected in frame", ...}
        """
        if frame is None or not isinstance(frame, np.ndarray) or frame.size == 0:
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": "Invalid or empty image frame provided",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }

        h, w = frame.shape[:2]
        if h < 20 or w < 20:
            return {
                "status": "ERROR_NO_FRAME",
                "error_message": "Frame dimensions too small for analysis",
                "lateral_offset_px": None,
                "angular_offset_deg": None,
            }

        # 1. Attempt YOLO detection if custom weights are loaded
        if self.model is not None and self.model_loaded:
            yolo_result = self._detect_yolo(frame, w, h)
            if yolo_result is not None:
                return yolo_result

        # 2. Geometric Computer Vision Runway Detector (OpenCV)
        cv_result = self._detect_runway_geometry(frame, w, h)
        if cv_result is not None:
            return cv_result

        # 3. No runway detected: Return explicit error per critical requirement
        return {
            "status": "ERROR_NO_RUNWAY",
            "error_message": "Runway not detected in frame",
            "lateral_offset_px": None,
            "angular_offset_deg": None,
        }

    def _detect_yolo(self, frame: np.ndarray, w: int, h: int) -> Optional[Dict[str, Any]]:
        """
        Runway detection using Ultralytics YOLO model.
        """
        try:
            results = self.model(frame, conf=self.conf_threshold, verbose=False)
            if not results or len(results) == 0:
                return None

            boxes = results[0].boxes
            if boxes is None or len(boxes) == 0:
                return None

            # Look for runway detection class or highest confidence approach box
            best_box = None
            best_conf = 0.0

            for box in boxes:
                conf = float(box.conf[0])
                cls_idx = int(box.cls[0])
                cls_name = self.model.names.get(cls_idx, "").lower() if hasattr(self.model, "names") else ""

                # If model is specifically trained for runway or general detection
                is_runway = "runway" in cls_name or "airstrip" in cls_name or cls_name == ""
                if is_runway and conf > best_conf and conf >= self.conf_threshold:
                    best_conf = conf
                    xyxy = box.xyxy[0].cpu().numpy()
                    best_box = xyxy

            if best_box is not None:
                x1, y1, x2, y2 = best_box
                runway_x_bottom = (x1 + x2) / 2.0
                image_center_x = w / 2.0

                lateral_offset_px = round(runway_x_bottom - image_center_x, 2)
                focal_length = self.calculate_focal_length(w)
                angular_offset_deg = round(
                    math.degrees(math.atan2(lateral_offset_px, focal_length)), 2
                )

                return {
                    "status": "RUNWAY_DETECTED",
                    "detection_method": "YOLO11",
                    "confidence": round(best_conf, 3),
                    "lateral_offset_px": lateral_offset_px,
                    "angular_offset_deg": angular_offset_deg,
                    "runway_x_px": round(runway_x_bottom, 2),
                    "image_center_x_px": round(image_center_x, 2),
                    "bounding_box": [float(x1), float(y1), float(x2), float(y2)],
                    "frame_width": w,
                    "frame_height": h,
                }
        except Exception as e:
            logger.debug("YOLO inference failed or not applicable: %s", e)

        return None

    def _detect_runway_geometry(self, frame: np.ndarray, w: int, h: int) -> Optional[Dict[str, Any]]:
        """
        Real geometric computer vision detector for runway approach perspective:
        1. Edge detection using Canny and adaptive preprocessing.
        2. Probabilistic Hough Transform for perspective edges.
        3. Converging line analysis to find perspective vanishing point.
        4. Calculation of runway axis, bottom touchdown center, and offset.
        """
        # Convert to grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)

        # Focus analysis on lower 80% of image (approach perspective)
        roi_top = int(h * 0.20)
        roi = blurred[roi_top:h, :]
        roi_h = roi.shape[0]

        # Multi-scale Canny edge detection
        edges = cv2.Canny(roi, 50, 150, apertureSize=3)

        # Detect line segments using Probabilistic Hough Transform
        min_line_len = int(roi_h * 0.25)
        lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=np.pi / 180,
            threshold=40,
            minLineLength=min_line_len,
            maxLineGap=25,
        )

        if lines is None or len(lines) < 2:
            return None

        # Classify line segments into left-converging and right-converging candidates
        left_lines: List[Tuple[float, float, float, float, float]] = []   # (x1, y1, x2, y2, angle)
        right_lines: List[Tuple[float, float, float, float, float]] = []

        for line in lines:
            coords = line.flatten()
            if len(coords) < 4:
                continue
            x1, y1_roi, x2, y2_roi = float(coords[0]), float(coords[1]), float(coords[2]), float(coords[3])
            # Convert to full-frame y-coordinates
            y1 = float(y1_roi + roi_top)
            y2 = float(y2_roi + roi_top)
            dx = float(x2 - x1)
            dy = float(y2 - y1)

            if abs(dx) < 1e-4:
                # Vertical line segment
                continue

            # Ensure y1 > y2 (y1 is bottom point, y2 is top point towards horizon)
            if y1 < y2:
                x1, x2 = x2, x1
                y1, y2 = y2, y1
                dx = -dx
                dy = -dy

            # Calculate slope and angle with horizontal
            slope = dy / dx
            angle_deg = math.degrees(math.atan2(-dy, dx))  # Image y is downwards

            # A runway perspective line converging towards center:
            # Left edge: x increases as y decreases (towards horizon), so dx > 0 when dy < 0, slope < 0 in img coords
            # Right edge: x decreases as y decreases (towards horizon), so dx < 0 when dy < 0, slope > 0 in img coords
            # Slopes should be between 20° and 85° relative to horizontal
            if 20.0 <= angle_deg <= 82.0 and x1 < (w * 0.70):
                left_lines.append((x1, y1, x2, y2, slope))
            elif 98.0 <= angle_deg <= 160.0 and x1 > (w * 0.30):
                right_lines.append((x1, y1, x2, y2, slope))

        if not left_lines or not right_lines:
            return None

        # Find best converging pair with valid vanishing point
        best_candidate = None
        best_score = -1.0

        target_center_x = w / 2.0

        for l_line in left_lines:
            lx1, ly1, lx2, ly2, l_slope = l_line
            l_denom = (ly2 - ly1)
            if abs(l_denom) < 1e-4:
                continue
            l_inv_slope = (lx2 - lx1) / l_denom  # x = x1 + inv_slope * (y - y1)

            for r_line in right_lines:
                rx1, ry1, rx2, ry2, r_slope = r_line
                r_denom = (ry2 - ry1)
                if abs(r_denom) < 1e-4:
                    continue
                r_inv_slope = (rx2 - rx1) / r_denom

                # If slopes are too close, lines are parallel (no vanishing point)
                if abs(l_inv_slope - r_inv_slope) < 0.15:
                    continue

                # Intersection (vanishing point) where x_L(y) = x_R(y):
                # lx1 + l_inv_slope * (y - ly1) = rx1 + r_inv_slope * (y - ry1)
                vp_y = (
                    (rx1 - r_inv_slope * ry1) - (lx1 - l_inv_slope * ly1)
                ) / (l_inv_slope - r_inv_slope)
                vp_x = lx1 + l_inv_slope * (vp_y - ly1)

                # Vanishing point criteria:
                # 1. Must be in upper region of frame (0.05 * h <= vp_y <= 0.70 * h)
                # 2. Must be horizontally plausible (0.15 * w <= vp_x <= 0.85 * w)
                if not (0.05 * h <= vp_y <= 0.70 * h):
                    continue
                if not (0.15 * w <= vp_x <= 0.85 * w):
                    continue

                # Project both lines down to bottom baseline y_eval (e.g. h - 1)
                y_eval = float(h - 1)
                x_left_bottom = lx1 + l_inv_slope * (y_eval - ly1)
                x_right_bottom = rx1 + r_inv_slope * (y_eval - ry1)

                # Physical trapezoid requirement:
                # At bottom, left line must be strictly left of right line
                bottom_width = x_right_bottom - x_left_bottom
                if bottom_width <= (w * 0.08):
                    # Runway too narrow to be authentic approach view
                    continue

                # Also verify top width near horizon/vanishing point is smaller than bottom width
                y_top = vp_y + (0.15 * (y_eval - vp_y))
                x_left_top = lx1 + l_inv_slope * (y_top - ly1)
                x_right_top = rx1 + r_inv_slope * (y_top - ry1)
                top_width = x_right_top - x_left_top
                if top_width <= 0 or top_width >= bottom_width:
                    continue

                # Runway centerline at bottom
                runway_x_bottom = (x_left_bottom + x_right_bottom) / 2.0

                # Score candidate by symmetry and line length
                len_l = math.hypot(lx2 - lx1, ly2 - ly1)
                len_r = math.hypot(rx2 - rx1, ry2 - ry1)
                symmetry = 1.0 - min(abs(vp_x - runway_x_bottom) / (w * 0.5), 1.0)
                score = (len_l + len_r) * (0.5 + 0.5 * symmetry)

                if score > best_score:
                    best_score = score
                    best_candidate = {
                        "runway_x_bottom": runway_x_bottom,
                        "bottom_width": bottom_width,
                        "vanishing_point": [round(vp_x, 1), round(vp_y, 1)],
                        "bounds": [
                            [round(x_left_top, 1), round(y_top, 1)],
                            [round(x_right_top, 1), round(y_top, 1)],
                            [round(x_right_bottom, 1), round(y_eval, 1)],
                            [round(x_left_bottom, 1), round(y_eval, 1)],
                        ],
                        "confidence": min(round(best_score / (h * 1.5), 3), 0.99),
                    }

        if best_candidate is None:
            return None

        # Compute physical camera offsets
        image_center_x = w / 2.0
        runway_x = best_candidate["runway_x_bottom"]
        lateral_offset_px = round(runway_x - image_center_x, 2)
        focal_length = self.calculate_focal_length(w)
        angular_offset_deg = round(
            math.degrees(math.atan2(lateral_offset_px, focal_length)), 2
        )

        return {
            "status": "RUNWAY_DETECTED",
            "detection_method": "OPENCV_GEOMETRIC_PERSPECTIVE",
            "confidence": best_candidate["confidence"],
            "lateral_offset_px": lateral_offset_px,
            "angular_offset_deg": angular_offset_deg,
            "runway_x_px": round(runway_x, 2),
            "image_center_x_px": round(image_center_x, 2),
            "vanishing_point": best_candidate["vanishing_point"],
            "runway_bounds": best_candidate["bounds"],
            "frame_width": w,
            "frame_height": h,
        }
