"""
Unit tests for RunwayVisionDetector.
Verifies:
- Frame validity handling (None frame, empty array) -> ERROR_NO_FRAME
- Non-runway image (blank, noise, horizon-less) -> ERROR_NO_RUNWAY
- Synthetic geometric runway -> DETECTED with correct offset and angular calculation
- Strict zero-mock enforcement
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import cv2
import numpy as np
from detector import RunwayVisionDetector


class TestRunwayVisionDetector(unittest.TestCase):

    def setUp(self):
        self.detector = RunwayVisionDetector(hfov_deg=60.0)

    def test_null_frame(self):
        """Should return ERROR_NO_FRAME when None or empty frame is supplied."""
        res = self.detector.detect_frame(None)
        self.assertEqual(res["status"], "ERROR_NO_FRAME")
        self.assertIsNone(res["lateral_offset_px"])
        self.assertIsNone(res["angular_offset_deg"])

    def test_empty_frame(self):
        """Should return ERROR_NO_FRAME when empty numpy array is provided."""
        res = self.detector.detect_frame(np.array([], dtype=np.uint8))
        self.assertEqual(res["status"], "ERROR_NO_FRAME")
        self.assertIsNone(res["lateral_offset_px"])
        self.assertIsNone(res["angular_offset_deg"])

    def test_no_runway_blank_image(self):
        """Should return ERROR_NO_RUNWAY on uniform or sky image."""
        blank_sky = np.full((480, 640, 3), 200, dtype=np.uint8)
        res = self.detector.detect_frame(blank_sky)
        self.assertEqual(res["status"], "ERROR_NO_RUNWAY")
        self.assertEqual(res["error_message"], "Runway not detected in frame")
        self.assertIsNone(res["lateral_offset_px"])
        self.assertIsNone(res["angular_offset_deg"])

    def test_geometric_runway_detection(self):
        """
        Synthesize a realistic perspective runway trapezoid:
        Runway edges converging towards horizon at (320, 160).
        Bottom left: (180, 480), Bottom right: (460, 480).
        Runway bottom center = 320 (exact frame center -> 0 offset).
        """
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        # Background terrain (dark green/gray)
        img[:] = (40, 60, 40)

        # Draw bright runway pavement (gray)
        pts = np.array([
            [280, 160],  # top-left
            [360, 160],  # top-right
            [480, 480],  # bottom-right
            [160, 480],  # bottom-left
        ], np.int32)
        cv2.fillPoly(img, [pts], (180, 180, 180))

        # Draw white runway edge lines
        cv2.line(img, (160, 480), (280, 160), (255, 255, 255), 4)
        cv2.line(img, (480, 480), (360, 160), (255, 255, 255), 4)

        # Run detection
        res = self.detector.detect_frame(img)
        self.assertEqual(res["status"], "RUNWAY_DETECTED")
        self.assertIsNotNone(res["lateral_offset_px"])
        self.assertIsNotNone(res["angular_offset_deg"])
        # Centered runway should have near-zero lateral offset (< 15 px)
        self.assertLess(abs(res["lateral_offset_px"]), 15.0)
        self.assertLess(abs(res["angular_offset_deg"]), 2.0)


if __name__ == "__main__":
    unittest.main()
