// avif.rs — pure-Rust AVIF decoding.
//
// The `image` crate can only decode AVIF through libdav1d (a C library that is
// awkward to provide on Windows), so glasspane decodes AVIF itself:
//   - `avif-parse` reads the container and hands back the primary (colour) and
//     optional alpha AV1 items;
//   - `rav1d` — the Rust port of dav1d — decodes each item to YUV planes;
//   - this module converts those planes to 8-bit RGB(A).
//
// 8-bit output is all a viewer that renders in a webview / re-encodes to JPEG
// needs; 10/12-bit sources are scaled down, not clipped. Chroma for 4:2:0 and
// 4:2:2 is upsampled nearest-neighbour (co-sited), which is fine for viewing.
//
// Only compiled with the `avif` cargo feature (on by default — no system libs).

use std::io::Cursor;

use image::{DynamicImage, RgbImage, RgbaImage};
use rav1d::pixel::{MatrixCoefficients, YUVRange};
use rav1d::{Decoder, Picture, PixelLayout, PlanarImageComponent, Rav1dError, Settings};

/// Decode an AVIF file into an 8-bit RGB image, or RGBA when it carries alpha.
pub fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let data = parse(bytes)?;
    let color = decode_av1(data.primary_item.as_slice())?;
    let alpha = match &data.alpha_item {
        Some(item) if !item.is_empty() => Some(decode_av1(item.as_slice())?),
        _ => None,
    };
    to_rgb(&color, alpha.as_ref(), data.premultiplied_alpha)
}

/// Image dimensions from the container's item properties — no AV1 decode.
pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let meta = parse(bytes)?
        .primary_item_metadata()
        .map_err(|e| format!("avif metadata: {e}"))?;
    Ok((meta.max_frame_width.get(), meta.max_frame_height.get()))
}

fn parse(bytes: &[u8]) -> Result<avif_parse::AvifData, String> {
    avif_parse::AvifData::from_reader(&mut Cursor::new(bytes))
        .map_err(|e| format!("avif container: {e}"))
}

/// Decode one AV1 item (a single still frame) with rav1d.
fn decode_av1(obu: &[u8]) -> Result<Picture, String> {
    // Single-threaded, no frame delay: a still image decodes synchronously, so
    // the picture is ready as soon as the data has been consumed.
    let mut settings = Settings::new();
    settings.set_n_threads(1);
    settings.set_max_frame_delay(1);
    let mut dec = Decoder::with_settings(&settings).map_err(|e| format!("rav1d init: {e:?}"))?;

    match dec.send_data(obu.to_vec().into_boxed_slice(), None, None, None) {
        // `TryAgain` = a picture is ready and must be fetched before the rest of
        // the buffer is consumed — handled by the loop below.
        Ok(()) | Err(Rav1dError::TryAgain) => {}
        Err(e) => return Err(format!("rav1d send: {e:?}")),
    }

    // Bounded so a truncated bitstream can never spin forever.
    for _ in 0..64 {
        match dec.get_picture() {
            Ok(pic) => return Ok(pic),
            Err(Rav1dError::TryAgain) => match dec.send_pending_data() {
                Ok(()) | Err(Rav1dError::TryAgain) => {}
                Err(e) => return Err(format!("rav1d: {e:?}")),
            },
            Err(e) => return Err(format!("rav1d: {e:?}")),
        }
    }
    Err("rav1d: bitstream ended without a picture".into())
}

// ---------------------------------------------------------------------------
// YUV -> RGB
// ---------------------------------------------------------------------------

/// One decoded plane. `hbd` = 16-bit storage (10/12-bit content), little-endian.
struct Plane<'a> {
    data: &'a [u8],
    stride: usize,
    hbd: bool,
}

impl Plane<'_> {
    fn new(
        pic: &Picture,
        c: PlanarImageComponent,
        w: usize,
        h: usize,
    ) -> Result<Plane<'_>, String> {
        let data = pic.plane(c);
        let stride = pic.stride(c) as usize;
        // `bit_depth()` is the content depth (8/10/12); anything above 8 is
        // stored as little-endian u16 samples, with `stride` still in bytes.
        let hbd = pic.bit_depth() > 8;
        let bytes = if hbd { 2 } else { 1 };
        let need = (h - 1) * stride + w * bytes;
        if stride < w * bytes || data.len() < need {
            return Err(format!(
                "avif: plane {c:?} smaller than expected ({} < {need})",
                data.len()
            ));
        }
        Ok(Plane { data, stride, hbd })
    }

    #[inline]
    fn get(&self, x: usize, y: usize) -> u32 {
        if self.hbd {
            let i = y * self.stride + x * 2;
            u16::from_le_bytes([self.data[i], self.data[i + 1]]) as u32
        } else {
            self.data[y * self.stride + x] as u32
        }
    }
}

/// How to turn the three planes into RGB.
enum Model {
    /// Y'CbCr with the given Kr/Kb (BT.601/709/2020, …).
    KrKb(f32, f32),
    /// Y = G, U = B, V = R (lossless AVIF), 4:4:4 only.
    Identity,
    YCgCo,
    /// 4:0:0 — luma only.
    Gray,
}

fn model_for(mc: MatrixCoefficients, layout: PixelLayout) -> Result<Model, String> {
    use MatrixCoefficients as M;
    if layout == PixelLayout::I400 {
        return Ok(Model::Gray);
    }
    Ok(match mc {
        M::Identity => {
            if layout != PixelLayout::I444 {
                return Err(format!(
                    "avif: Identity matrix requires 4:4:4, got {layout:?}"
                ));
            }
            Model::Identity
        }
        // `Unspecified` is common; Chrome and `image` both assume BT.709 for it.
        M::BT709 | M::Unspecified => Model::KrKb(0.2126, 0.0722),
        M::BT470BG | M::ST170M => Model::KrKb(0.299, 0.114),
        M::BT470M => Model::KrKb(0.30, 0.11),
        M::ST240M => Model::KrKb(0.212, 0.087),
        M::BT2020NonConstantLuminance => Model::KrKb(0.2627, 0.0593),
        M::YCgCo => Model::YCgCo,
        other => return Err(format!("avif: unsupported matrix coefficients {other:?}")),
    })
}

/// Sample-value -> [0,1] normalisation for a given bit depth and range.
struct Norm {
    y0: f32,
    yr: f32,
    c0: f32,
    cr: f32,
}

impl Norm {
    fn new(bpc: u32, range: YUVRange) -> Norm {
        let scale = (1u32 << (bpc - 8)) as f32;
        let maxv = ((1u32 << bpc) - 1) as f32;
        match range {
            YUVRange::Full => Norm {
                y0: 0.0,
                yr: maxv,
                c0: (1u32 << (bpc - 1)) as f32,
                cr: maxv,
            },
            YUVRange::Limited => Norm {
                y0: 16.0 * scale,
                yr: 219.0 * scale,
                c0: 128.0 * scale,
                cr: 224.0 * scale,
            },
        }
    }
    #[inline]
    fn luma(&self, v: u32) -> f32 {
        (v as f32 - self.y0) / self.yr
    }
    #[inline]
    fn chroma(&self, v: u32) -> f32 {
        (v as f32 - self.c0) / self.cr
    }
}

#[inline]
fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

fn to_rgb(
    pic: &Picture,
    alpha: Option<&Picture>,
    premultiplied: bool,
) -> Result<DynamicImage, String> {
    let (w, h) = (pic.width() as usize, pic.height() as usize);
    if w == 0 || h == 0 {
        return Err("avif: zero-sized image".into());
    }
    let bpc = pic.bit_depth() as u32;
    let layout = pic.pixel_layout();
    let model = model_for(pic.matrix_coefficients(), layout)?;
    let norm = Norm::new(bpc, pic.color_range());

    // chroma plane geometry (nearest-neighbour upsampling: shift the coords)
    let (sx, sy) = match layout {
        PixelLayout::I420 => (1, 1),
        PixelLayout::I422 => (1, 0),
        _ => (0, 0),
    };
    let (cw, ch) = ((w + (1 << sx) - 1) >> sx, (h + (1 << sy) - 1) >> sy);

    let yp = Plane::new(pic, PlanarImageComponent::Y, w, h)?;
    let (up, vp) = if matches!(model, Model::Gray) {
        (None, None)
    } else {
        (
            Some(Plane::new(pic, PlanarImageComponent::U, cw, ch)?),
            Some(Plane::new(pic, PlanarImageComponent::V, cw, ch)?),
        )
    };

    // per-pixel RGB in [0,1]
    let rgb_at = |x: usize, y: usize| -> [f32; 3] {
        let yv = yp.get(x, y);
        let (u, v) = match (&up, &vp) {
            (Some(up), Some(vp)) => (up.get(x >> sx, y >> sy), vp.get(x >> sx, y >> sy)),
            _ => (0, 0),
        };
        match model {
            Model::Gray => {
                let l = norm.luma(yv);
                [l, l, l]
            }
            Model::Identity => [norm.luma(v), norm.luma(yv), norm.luma(u)], // V=R, Y=G, U=B
            Model::YCgCo => {
                let (l, cg, co) = (norm.luma(yv), norm.chroma(u), norm.chroma(v));
                [l - cg + co, l + cg, l - cg - co]
            }
            Model::KrKb(kr, kb) => {
                let kg = 1.0 - kr - kb;
                let (l, cb, cr) = (norm.luma(yv), norm.chroma(u), norm.chroma(v));
                [
                    l + 2.0 * (1.0 - kr) * cr,
                    l - (2.0 * kb * (1.0 - kb) / kg) * cb - (2.0 * kr * (1.0 - kr) / kg) * cr,
                    l + 2.0 * (1.0 - kb) * cb,
                ]
            }
        }
    };

    match alpha {
        None => {
            let mut out = RgbImage::new(w as u32, h as u32);
            for (x, y, px) in out.enumerate_pixels_mut() {
                let [r, g, b] = rgb_at(x as usize, y as usize);
                *px = image::Rgb([to_u8(r), to_u8(g), to_u8(b)]);
            }
            Ok(DynamicImage::ImageRgb8(out))
        }
        Some(ap) => {
            if (ap.width() as usize, ap.height() as usize) != (w, h) {
                return Err("avif: alpha plane size differs from the image".into());
            }
            if ap.pixel_layout() != PixelLayout::I400 {
                return Err(format!(
                    "avif: alpha must be 4:0:0, got {:?}",
                    ap.pixel_layout()
                ));
            }
            let abpc = ap.bit_depth() as u32;
            let anorm = Norm::new(abpc, ap.color_range());
            let aplane = Plane::new(ap, PlanarImageComponent::Y, w, h)?;

            let mut out = RgbaImage::new(w as u32, h as u32);
            for (x, y, px) in out.enumerate_pixels_mut() {
                let (x, y) = (x as usize, y as usize);
                let a = anorm.luma(aplane.get(x, y)).clamp(0.0, 1.0);
                let mut rgb = rgb_at(x, y);
                if premultiplied && a > 0.0 {
                    for c in &mut rgb {
                        *c /= a;
                    }
                }
                *px = image::Rgba([to_u8(rgb[0]), to_u8(rgb[1]), to_u8(rgb[2]), to_u8(a)]);
            }
            Ok(DynamicImage::ImageRgba8(out))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — real AVIF fixtures (made with avifenc from a 32×20 image whose left
// half is (200,80,40) and right half is (40,80,200); see tests/fixtures).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const F420_8: &[u8] = include_bytes!("../tests/fixtures/halves_420_8bit.avif");
    const F420_10: &[u8] = include_bytes!("../tests/fixtures/halves_420_10bit.avif");
    const F444_LL: &[u8] = include_bytes!("../tests/fixtures/halves_444_lossless.avif");
    const FALPHA: &[u8] = include_bytes!("../tests/fixtures/alpha_8bit.avif");

    const LEFT: [u8; 3] = [200, 80, 40];
    const RIGHT: [u8; 3] = [40, 80, 200];

    fn px(img: &DynamicImage, x: u32, y: u32) -> [u8; 4] {
        img.to_rgba8().get_pixel(x, y).0
    }

    fn assert_close(got: [u8; 4], want: [u8; 3], tol: i32, what: &str) {
        for i in 0..3 {
            let d = (got[i] as i32 - want[i] as i32).abs();
            assert!(
                d <= tol,
                "{what}: channel {i} got {} want {} (tol {tol})",
                got[i],
                want[i]
            );
        }
    }

    #[test]
    fn dimensions_come_from_the_container() {
        for f in [F420_8, F420_10, F444_LL, FALPHA] {
            assert_eq!(dimensions(f).unwrap(), (32, 20));
        }
    }

    #[test]
    fn decodes_8bit_420_lossy() {
        let img = decode(F420_8).unwrap();
        assert_eq!((img.width(), img.height()), (32, 20));
        assert!(matches!(img, DynamicImage::ImageRgb8(_)), "no alpha → RGB8");
        assert_close(px(&img, 4, 10), LEFT, 16, "left");
        assert_close(px(&img, 28, 10), RIGHT, 16, "right");
    }

    #[test]
    fn decodes_10bit_420_lossy() {
        let img = decode(F420_10).unwrap();
        assert_eq!((img.width(), img.height()), (32, 20));
        assert_close(px(&img, 4, 10), LEFT, 16, "left");
        assert_close(px(&img, 28, 10), RIGHT, 16, "right");
    }

    #[test]
    fn decodes_444_lossless_exactly() {
        let img = decode(F444_LL).unwrap();
        assert_close(px(&img, 4, 10), LEFT, 1, "left");
        assert_close(px(&img, 28, 10), RIGHT, 1, "right");
        // lossless means the half boundary is crisp, too
        assert_close(px(&img, 15, 0), LEFT, 1, "last left column");
        assert_close(px(&img, 16, 0), RIGHT, 1, "first right column");
    }

    #[test]
    fn decodes_alpha_into_rgba() {
        let img = decode(FALPHA).unwrap();
        assert!(matches!(img, DynamicImage::ImageRgba8(_)), "alpha → RGBA8");
        let l = px(&img, 4, 10);
        let r = px(&img, 28, 10);
        assert!(l[3] >= 250, "left is opaque, got alpha {}", l[3]);
        assert!(r[3] <= 5, "right is transparent, got alpha {}", r[3]);
        assert_close(l, LEFT, 16, "left colour");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode(b"definitely not an avif").is_err());
        assert!(dimensions(&[0u8; 16]).is_err());
    }
}
