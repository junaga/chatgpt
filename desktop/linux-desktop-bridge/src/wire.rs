use std::io::{Read, Write};

use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub fn read_frame<T: DeserializeOwned>(reader: &mut impl Read) -> Result<Option<T>, WireError> {
    let mut length = [0_u8; 4];
    loop {
        match reader.read(&mut length[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => unreachable!("a one-byte buffer cannot accept more than one byte"),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    reader.read_exact(&mut length[1..])?;
    let length = usize::try_from(u32::from_le_bytes(length))
        .map_err(|_| WireError::FrameTooLarge(usize::MAX))?;
    if length > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge(length));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(serde_json::from_slice(&payload)?))
}

pub fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> Result<(), WireError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge(payload.len()));
    }
    let length = u32::try_from(payload.len()).map_err(|_| WireError::FrameTooLarge(payload.len()))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum WireError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame is too large: {0} bytes")]
    FrameTooLarge(usize),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BridgeOperation, BridgeRequest};

    #[test]
    fn round_trips_little_endian_length_prefixed_json() {
        let request = BridgeRequest::new(12, BridgeOperation::ListApps);
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize,
            bytes.len() - 4
        );
        assert_eq!(
            read_frame::<BridgeRequest>(&mut bytes.as_slice()).unwrap(),
            Some(request)
        );
    }

    #[test]
    fn clean_eof_is_not_an_error() {
        assert_eq!(
            read_frame::<BridgeRequest>(&mut [].as_slice()).unwrap(),
            None
        );
    }

    #[test]
    fn truncated_header_is_an_error() {
        assert!(matches!(
            read_frame::<BridgeRequest>(&mut [1_u8, 0].as_slice()),
            Err(WireError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof
        ));
    }

    #[test]
    fn rejects_oversized_frames_before_allocation() {
        let bytes = u32::try_from(MAX_FRAME_BYTES + 1).unwrap().to_le_bytes();
        assert!(matches!(
            read_frame::<BridgeRequest>(&mut bytes.as_slice()),
            Err(WireError::FrameTooLarge(_))
        ));
    }
}
