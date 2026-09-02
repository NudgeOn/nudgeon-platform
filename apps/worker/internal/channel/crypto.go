package channel

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

// 봉투 복호화 — apps/api/src/crypto/envelope.ts와 레이아웃 호환:
// nonce(12B) || ciphertext || GCM tag(16B). DEK 래핑도 동일 레이아웃.
const nonceLen = 12

// LoadMasterKey는 NUDGEON_MASTER_KEY(base64 32B) 또는 KMS_MASTER_KEY_FILE에서 마스터키를 읽는다.
func LoadMasterKey() ([]byte, error) {
	if inline := os.Getenv("NUDGEON_MASTER_KEY"); inline != "" {
		key, err := base64.StdEncoding.DecodeString(inline)
		if err != nil || len(key) != 32 {
			return nil, errors.New("NUDGEON_MASTER_KEY는 base64 32바이트여야 합니다")
		}
		return key, nil
	}
	if file := os.Getenv("KMS_MASTER_KEY_FILE"); file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("마스터키 파일: %w", err)
		}
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(key) != 32 {
			return nil, errors.New("마스터키 파일은 base64 32바이트여야 합니다")
		}
		return key, nil
	}
	return nil, errors.New("마스터키 미설정 — NUDGEON_MASTER_KEY 또는 KMS_MASTER_KEY_FILE 필요")
}

func openSealed(key, sealed []byte) ([]byte, error) {
	if len(sealed) < nonceLen+16 {
		return nil, errors.New("sealed 데이터가 너무 짧음")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, sealed[:nonceLen], sealed[nonceLen:], nil)
}

// DecryptEnvelope은 (ciphertext, dek_wrapped)를 평문으로 복호화한다.
func DecryptEnvelope(masterKey, ciphertext, dekWrapped []byte) ([]byte, error) {
	dek, err := openSealed(masterKey, dekWrapped)
	if err != nil {
		return nil, fmt.Errorf("DEK 언래핑: %w", err)
	}
	plain, err := openSealed(dek, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("본문 복호화: %w", err)
	}
	return plain, nil
}
