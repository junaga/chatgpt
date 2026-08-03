use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalPoint {
    pub x: f64,
    pub y: f64,
}

/// Continuous frame coordinate. Values describe positions in the frame
/// rectangle, not integer pixel indexes; transformed monitor edges can equal
/// the frame width or height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FramePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    #[must_use]
    pub fn contains(self, point: LogicalPoint) -> bool {
        point.x >= self.x
            && point.y >= self.y
            && point.x < self.x + self.width
            && point.y < self.y + self.height
    }
}

/// Explicit transform from normalized logical coordinates to normalized frame
/// coordinates. Portal adapters must populate this from observed stream
/// metadata; the core never guesses monitor rotation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FrameTransform {
    #[default]
    Identity,
    Rotate90Clockwise,
    Rotate180,
    Rotate270Clockwise,
    FlipHorizontal,
    FlipVertical,
    Transpose,
    Transverse,
}

impl FrameTransform {
    fn logical_to_frame(self, u: f64, v: f64) -> (f64, f64) {
        match self {
            Self::Identity => (u, v),
            Self::Rotate90Clockwise => (1.0 - v, u),
            Self::Rotate180 => (1.0 - u, 1.0 - v),
            Self::Rotate270Clockwise => (v, 1.0 - u),
            Self::FlipHorizontal => (1.0 - u, v),
            Self::FlipVertical => (u, 1.0 - v),
            Self::Transpose => (v, u),
            Self::Transverse => (1.0 - v, 1.0 - u),
        }
    }

    fn frame_to_logical(self, u: f64, v: f64) -> (f64, f64) {
        match self {
            Self::Identity => (u, v),
            Self::Rotate90Clockwise => (v, 1.0 - u),
            Self::Rotate180 => (1.0 - u, 1.0 - v),
            Self::Rotate270Clockwise => (1.0 - v, u),
            Self::FlipHorizontal => (1.0 - u, v),
            Self::FlipVertical => (u, 1.0 - v),
            Self::Transpose => (v, u),
            Self::Transverse => (1.0 - v, 1.0 - u),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorGeometry {
    pub stream_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping_id: Option<String>,
    pub logical_bounds: LogicalRect,
    pub frame_size: FrameSize,
    #[serde(default)]
    pub transform: FrameTransform,
}

impl MonitorGeometry {
    pub fn validate(&self) -> Result<(), CoordinateError> {
        validate_rect(self.logical_bounds)?;
        if self.stream_id.is_empty() {
            return Err(CoordinateError::EmptyStreamId);
        }
        if self.frame_size.width == 0 || self.frame_size.height == 0 {
            return Err(CoordinateError::EmptyFrame(self.stream_id.clone()));
        }
        Ok(())
    }

    pub fn logical_to_frame(
        &self,
        point: LogicalPoint,
    ) -> Result<FramePoint, CoordinateError> {
        if !self.logical_bounds.contains(point) {
            return Err(CoordinateError::PointOutsideMonitor {
                stream_id: self.stream_id.clone(),
                point,
            });
        }
        let u = (point.x - self.logical_bounds.x) / self.logical_bounds.width;
        let v = (point.y - self.logical_bounds.y) / self.logical_bounds.height;
        let (frame_u, frame_v) = self.transform.logical_to_frame(u, v);
        Ok(FramePoint {
            x: frame_u * f64::from(self.frame_size.width),
            y: frame_v * f64::from(self.frame_size.height),
        })
    }

    pub fn frame_to_logical(
        &self,
        point: FramePoint,
    ) -> Result<LogicalPoint, CoordinateError> {
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < 0.0
            || point.y < 0.0
            || point.x > f64::from(self.frame_size.width)
            || point.y > f64::from(self.frame_size.height)
        {
            return Err(CoordinateError::PointOutsideFrame {
                stream_id: self.stream_id.clone(),
                point,
            });
        }
        let u = point.x / f64::from(self.frame_size.width);
        let v = point.y / f64::from(self.frame_size.height);
        let (logical_u, logical_v) = self.transform.frame_to_logical(u, v);
        Ok(LogicalPoint {
            x: self.logical_bounds.x + logical_u * self.logical_bounds.width,
            y: self.logical_bounds.y + logical_v * self.logical_bounds.height,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetPoint {
    pub stream_id: String,
    pub mapping_id: Option<String>,
    pub logical: LogicalPoint,
    pub frame: FramePoint,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopLayout {
    monitors: Vec<MonitorGeometry>,
}

impl DesktopLayout {
    pub fn new(monitors: Vec<MonitorGeometry>) -> Result<Self, CoordinateError> {
        if monitors.is_empty() {
            return Err(CoordinateError::EmptyLayout);
        }
        let mut stream_ids = HashSet::new();
        for monitor in &monitors {
            monitor.validate()?;
            if !stream_ids.insert(monitor.stream_id.clone()) {
                return Err(CoordinateError::DuplicateStreamId(
                    monitor.stream_id.clone(),
                ));
            }
        }
        Ok(Self { monitors })
    }

    #[must_use]
    pub fn monitors(&self) -> &[MonitorGeometry] {
        &self.monitors
    }

    pub fn target_for_logical(
        &self,
        point: LogicalPoint,
    ) -> Result<TargetPoint, CoordinateError> {
        let monitor = self
            .monitors
            .iter()
            .find(|monitor| monitor.logical_bounds.contains(point))
            .ok_or(CoordinateError::PointOutsideLayout(point))?;
        Ok(TargetPoint {
            stream_id: monitor.stream_id.clone(),
            mapping_id: monitor.mapping_id.clone(),
            logical: point,
            frame: monitor.logical_to_frame(point)?,
        })
    }

    pub fn logical_for_frame(
        &self,
        stream_id: &str,
        point: FramePoint,
    ) -> Result<LogicalPoint, CoordinateError> {
        let monitor = self
            .monitors
            .iter()
            .find(|monitor| monitor.stream_id == stream_id)
            .ok_or_else(|| CoordinateError::UnknownStream(stream_id.into()))?;
        monitor.frame_to_logical(point)
    }

    /// Map a point from an app screenshot into compositor logical coordinates.
    /// The screenshot must represent exactly `window_bounds`; decorations or
    /// padding must be removed by the capture adapter before using this method.
    pub fn window_frame_to_logical(
        window_bounds: LogicalRect,
        screenshot_size: FrameSize,
        point: FramePoint,
    ) -> Result<LogicalPoint, CoordinateError> {
        validate_rect(window_bounds)?;
        if screenshot_size.width == 0 || screenshot_size.height == 0 {
            return Err(CoordinateError::EmptyWindowFrame);
        }
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < 0.0
            || point.y < 0.0
            || point.x >= f64::from(screenshot_size.width)
            || point.y >= f64::from(screenshot_size.height)
        {
            return Err(CoordinateError::PointOutsideWindowFrame(point));
        }
        Ok(LogicalPoint {
            x: window_bounds.x
                + point.x / f64::from(screenshot_size.width) * window_bounds.width,
            y: window_bounds.y
                + point.y / f64::from(screenshot_size.height) * window_bounds.height,
        })
    }
}

fn validate_rect(rect: LogicalRect) -> Result<(), CoordinateError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
    {
        return Err(CoordinateError::NonFiniteGeometry);
    }
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return Err(CoordinateError::EmptyLogicalRect);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum CoordinateError {
    #[error("desktop layout contains no monitors")]
    EmptyLayout,
    #[error("stream ID cannot be empty")]
    EmptyStreamId,
    #[error("duplicate stream ID: {0}")]
    DuplicateStreamId(String),
    #[error("stream {0} has an empty frame")]
    EmptyFrame(String),
    #[error("window screenshot has an empty frame")]
    EmptyWindowFrame,
    #[error("logical rectangle must have positive width and height")]
    EmptyLogicalRect,
    #[error("geometry contains a non-finite value")]
    NonFiniteGeometry,
    #[error("logical point {point:?} is outside stream {stream_id}")]
    PointOutsideMonitor {
        stream_id: String,
        point: LogicalPoint,
    },
    #[error("frame point {point:?} is outside stream {stream_id}")]
    PointOutsideFrame {
        stream_id: String,
        point: FramePoint,
    },
    #[error("logical point {0:?} is outside all shared monitors")]
    PointOutsideLayout(LogicalPoint),
    #[error("frame point {0:?} is outside the app screenshot")]
    PointOutsideWindowFrame(FramePoint),
    #[error("unknown stream: {0}")]
    UnknownStream(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(
        stream_id: &str,
        logical_bounds: LogicalRect,
        frame_size: FrameSize,
        transform: FrameTransform,
    ) -> MonitorGeometry {
        MonitorGeometry {
            stream_id: stream_id.into(),
            mapping_id: Some(format!("mapping-{stream_id}")),
            logical_bounds,
            frame_size,
            transform,
        }
    }

    #[test]
    fn maps_fractionally_scaled_monitor_in_both_directions() {
        let monitor = monitor(
            "one",
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 1280.0,
                height: 720.0,
            },
            FrameSize {
                width: 1920,
                height: 1080,
            },
            FrameTransform::Identity,
        );
        let logical = LogicalPoint { x: 640.0, y: 360.0 };
        let frame = monitor.logical_to_frame(logical).unwrap();
        assert_eq!(frame, FramePoint { x: 960.0, y: 540.0 });
        assert_eq!(monitor.frame_to_logical(frame).unwrap(), logical);
    }

    #[test]
    fn selects_monitor_with_negative_logical_origin() {
        let layout = DesktopLayout::new(vec![
            monitor(
                "left",
                LogicalRect {
                    x: -1920.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                FrameSize {
                    width: 1920,
                    height: 1080,
                },
                FrameTransform::Identity,
            ),
            monitor(
                "right",
                LogicalRect {
                    x: 0.0,
                    y: 0.0,
                    width: 2560.0,
                    height: 1440.0,
                },
                FrameSize {
                    width: 2560,
                    height: 1440,
                },
                FrameTransform::Identity,
            ),
        ])
        .unwrap();

        let target = layout
            .target_for_logical(LogicalPoint {
                x: -100.0,
                y: 400.0,
            })
            .unwrap();
        assert_eq!(target.stream_id, "left");
        assert_eq!(target.mapping_id.as_deref(), Some("mapping-left"));
        assert_eq!(target.frame.x, 1820.0);
    }

    #[test]
    fn all_frame_transforms_round_trip() {
        let transforms = [
            FrameTransform::Identity,
            FrameTransform::Rotate90Clockwise,
            FrameTransform::Rotate180,
            FrameTransform::Rotate270Clockwise,
            FrameTransform::FlipHorizontal,
            FrameTransform::FlipVertical,
            FrameTransform::Transpose,
            FrameTransform::Transverse,
        ];
        for transform in transforms {
            let monitor = monitor(
                "rotated",
                LogicalRect {
                    x: 10.0,
                    y: 20.0,
                    width: 100.0,
                    height: 50.0,
                },
                FrameSize {
                    width: 800,
                    height: 600,
                },
                transform,
            );
            let original = LogicalPoint { x: 35.0, y: 30.0 };
            let frame = monitor.logical_to_frame(original).unwrap();
            let round_trip = monitor.frame_to_logical(frame).unwrap();
            assert!((round_trip.x - original.x).abs() < 1e-9, "{transform:?}");
            assert!((round_trip.y - original.y).abs() < 1e-9, "{transform:?}");
        }
    }

    #[test]
    fn maps_window_screenshot_point_before_monitor_targeting() {
        let logical = DesktopLayout::window_frame_to_logical(
            LogicalRect {
                x: -500.0,
                y: 100.0,
                width: 1000.0,
                height: 500.0,
            },
            FrameSize {
                width: 2000,
                height: 1000,
            },
            FramePoint { x: 500.0, y: 500.0 },
        )
        .unwrap();
        assert_eq!(logical, LogicalPoint { x: -250.0, y: 350.0 });
    }

    #[test]
    fn rejects_duplicate_stream_ids() {
        let first = monitor(
            "duplicate",
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            FrameSize {
                width: 10,
                height: 10,
            },
            FrameTransform::Identity,
        );
        let error = DesktopLayout::new(vec![first.clone(), first]).unwrap_err();
        assert_eq!(error, CoordinateError::DuplicateStreamId("duplicate".into()));
    }
}
